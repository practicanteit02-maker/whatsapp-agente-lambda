import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ssmClient = new SSMClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const NOMBRE_TABLA = 'conversaciones-whatsapp';
const NOMBRE_TABLA_CONFIG = 'conversaciones-ai-config';
const MAX_MENSAJES_HISTORIAL = 10;

async function obtenerParametro(nombre) {
  const command = new GetParameterCommand({ Name: nombre, WithDecryption: true });
  const response = await ssmClient.send(command);
  return response.Parameter.Value;
}

async function obtenerHistorial(numeroTelefono) {
  const command = new GetCommand({
    TableName: NOMBRE_TABLA,
    Key: { numero_telefono: numeroTelefono },
  });
  const response = await dynamoClient.send(command);
  return response.Item?.historial || [];
}

async function guardarHistorial(numeroTelefono, historial) {
  const historialRecortado = historial.slice(-MAX_MENSAJES_HISTORIAL);
  const command = new PutCommand({
    TableName: NOMBRE_TABLA,
    Item: {
      numero_telefono: numeroTelefono,
      historial: historialRecortado,
      actualizado_en: new Date().toISOString(),
    },
  });
  await dynamoClient.send(command);
}

function construirThreadKey(phoneNumberId, phoneNumber, businessScopedUserId) {
  let contactKey;
  if (businessScopedUserId && String(businessScopedUserId).trim()) {
    contactKey = `bsuid:${String(businessScopedUserId).trim()}`;
  } else {
    const soloDigitos = String(phoneNumber || '').replace(/\D/g, '');
    contactKey = soloDigitos || String(phoneNumber || '');
  }
  return `${phoneNumberId}:${contactKey}`;
}

// Corrección del bug "la IA no responde en chats con businessScopedUserId":
// el payload del webhook "kapso" para whatsapp.message.received (ver
// .agents/skills/integrate-whatsapp/references/webhooks-event-types.md del
// panel) NO trae business_scoped_user_id en ningún campo — ni en
// body.contact, ni en body.conversation.contact, ni en body.message (los
// tres caminos que se probaban antes acá). Ese campo solo existe en el
// evento whatsapp.contact.identity_changed, que este handler ni procesa.
// El panel, en cambio, sí arma su threadKey con prioridad a
// businessScopedUserId cuando el contacto lo tiene (ver threadKeyFor() en
// src/lib/inbox-data.ts) — así que para cualquier chat con ese dato, la
// fila de "conversaciones-ai-config" queda guardada bajo una clave
// "bsuid:..." que esta Lambda nunca podía reconstruir, y siempre fallaba
// cerrado (IA tratada como apagada).
//
// La corrección: pedirle el dato a Kapso vía conversations.get() antes de
// calcular el threadKey — mismo patrón que resolveEventZona() en
// src/app/api/webhooks/whatsapp/route.ts del panel, caché de 8 minutos por
// conversationId incluida, para no pagar esta consulta extra en cada
// mensaje de una conversación activa.
const THREAD_KEY_CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutos, mismo valor que resolveEventZona() en el panel
const threadKeyCache = new Map(); // conversationId -> { threadKey, cachedAt }

/**
 * business_scoped_user_id puede venir en distintos niveles según cómo Kapso
 * arme la respuesta de conversations.get() — se prueban las formas
 * plausibles (plano, bajo "kapso", bajo "contact") en vez de asumir una
 * sola, mismo criterio defensivo que ya se usa en el panel para este mismo
 * dato (ver businessScopedUserId en src/app/api/conversations/route.ts).
 */
function extraerBusinessScopedUserId(conversacion) {
  return (
    conversacion?.business_scoped_user_id ??
    conversacion?.kapso?.business_scoped_user_id ??
    conversacion?.contact?.business_scoped_user_id ??
    undefined
  );
}

async function obtenerConversacion(kapsoKey, phoneNumberId, conversationId) {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/conversations/${conversationId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'X-API-Key': kapsoKey },
  });
  if (!response.ok) {
    throw new Error(`Kapso conversations.get falló (status=${response.status})`);
  }
  return response.json();
}

/**
 * threadKey correcto para este mensaje entrante — con el businessScopedUserId
 * real (si Kapso lo tiene para esta conversación), no la suposición vieja
 * que siempre daba undefined. Si la consulta a Kapso falla por cualquier
 * motivo, se sigue con el teléfono solo (mismo resultado que antes de esta
 * corrección) en vez de bloquear la respuesta de la IA por un problema de
 * red ajeno.
 */
async function resolverThreadKey(kapsoKey, phoneNumberId, conversationId, numero) {
  const cutoff = Date.now() - THREAD_KEY_CACHE_TTL_MS;
  for (const [id, entry] of threadKeyCache) {
    if (entry.cachedAt < cutoff) threadKeyCache.delete(id);
  }

  const cached = conversationId ? threadKeyCache.get(conversationId) : undefined;
  if (cached) return cached.threadKey;

  let businessScopedUserId;
  if (conversationId) {
    try {
      const conversacion = await obtenerConversacion(kapsoKey, phoneNumberId, conversationId);
      businessScopedUserId = extraerBusinessScopedUserId(conversacion);
    } catch (error) {
      console.error('No se pudo resolver businessScopedUserId vía conversations.get():', error);
    }
  }

  const threadKey = construirThreadKey(phoneNumberId, numero, businessScopedUserId);
  if (conversationId) {
    threadKeyCache.set(conversationId, { threadKey, cachedAt: Date.now() });
  }
  return threadKey;
}

async function obtenerAiEnabled(threadKey) {
  try {
    const command = new GetCommand({
      TableName: NOMBRE_TABLA_CONFIG,
      Key: { threadKey },
    });
    const response = await dynamoClient.send(command);
    return response.Item?.aiEnabled === true;
  } catch (error) {
    console.error('Error consultando conversaciones-ai-config:', error);
    return false;
  }
}

// Limita el rol de la IA a consultas de la empresa: la API de Gemini
// (generateContent, v1beta) acepta "systemInstruction" como campo separado
// de "contents" — un Content de solo texto que no cuenta como turno del
// historial. Se manda en cada llamada porque el endpoint es sin estado.
const INSTRUCCION_SISTEMA =
  'Eres un asistente de atención al cliente de esta empresa. Tu rol es ayudar ' +
  'únicamente con consultas relacionadas con la empresa y su negocio (productos, ' +
  'servicios, pedidos, horarios, precios, soporte, etc.). Si el cliente pregunta algo ' +
  'que no tiene relación con la empresa (temas de cultura general, chistes, temas ' +
  'personales u otros temas random), respóndele con amabilidad que no puedes ayudarle ' +
  'con eso, y ofrécele ayuda con algo relacionado con la empresa en su lugar. No seas ' +
  'cortante ni suenes robótico.';

async function preguntarAGemini(apiKey, historial) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  for (let intento = 1; intento <= 3; intento++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCCION_SISTEMA }] },
        contents: historial,
      }),
    });
    const data = await response.json();

    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    }

    if (data.error?.code === 503 && intento < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    return 'Lo siento, no pude generar una respuesta en este momento.';
  }
}

async function enviarRespuestaWhatsApp(apiKey, phoneNumberId, numeroDestino, texto) {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: numeroDestino,
      type: 'text',
      text: { preview_url: false, body: texto },
    }),
  });
  const textoRespuesta = await response.text();
  console.log('Status de Kapso:', response.status);
}

export const handler = async (event) => {
  try {
    const tipoEvento = event.headers?.['x-webhook-event'] || event.headers?.['X-Webhook-Event'];

    if (tipoEvento !== 'whatsapp.message.received') {
      return { statusCode: 200, body: JSON.stringify({ status: 'ignorado_tipo_evento' }) };
    }

    const body = JSON.parse(event.body);
    const textoRecibido = body.message?.text?.body;
    const numero = body.conversation?.phone_number;
    const phoneNumberId = body.phone_number_id;
    const conversationId = body.conversation?.id;

    if (body.message?.kapso?.direction === 'outbound') {
      return { statusCode: 200, body: JSON.stringify({ status: 'ignorado_outbound' }) };
    }

    if (!textoRecibido || !numero || !phoneNumberId) {
      return { statusCode: 200, body: JSON.stringify({ status: 'ignorado' }) };
    }

    // Se necesita ANTES del threadKey ahora (para poder pedirle la
    // conversación a Kapso) — antes solo se pedía si la IA terminaba
    // respondiendo. Se reusa más abajo para enviarRespuestaWhatsApp, no se
    // vuelve a pedir.
    const kapsoKey = await obtenerParametro('/whatsapp-agente/kapso-api-key');

    const threadKey = await resolverThreadKey(kapsoKey, phoneNumberId, conversationId, numero);
    const iaActiva = await obtenerAiEnabled(threadKey);
    if (!iaActiva) {
      console.log(`IA desactivada para threadKey=${threadKey}`);
      return { statusCode: 200, body: JSON.stringify({ status: 'ia_desactivada' }) };
    }

    console.log(`Mensaje de ${numero}: "${textoRecibido}"`);

    const geminiKey = await obtenerParametro('/whatsapp-agente/gemini-api-key');

    const historialAnterior = await obtenerHistorial(numero);

    const historialActualizado = [
      ...historialAnterior,
      { role: 'user', parts: [{ text: textoRecibido }] },
    ];

    const respuestaIA = await preguntarAGemini(geminiKey, historialActualizado);
    console.log(`Respuesta de Gemini: "${respuestaIA}"`);

    historialActualizado.push({ role: 'model', parts: [{ text: respuestaIA }] });
    await guardarHistorial(numero, historialActualizado);

    await enviarRespuestaWhatsApp(kapsoKey, phoneNumberId, numero, respuestaIA);

    return { statusCode: 200, body: JSON.stringify({ status: 'respondido' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 200, body: JSON.stringify({ status: 'error', detalle: error.message }) };
  }
};
