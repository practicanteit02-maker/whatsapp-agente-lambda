import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const ssmClient = new SSMClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const NOMBRE_TABLA = 'conversaciones-whatsapp';
const NOMBRE_TABLA_CONFIG = 'conversaciones-ai-config';
const MAX_MENSAJES_HISTORIAL = 10;

// Corrección del bug "timeout de 30s + respuestas duplicadas": ninguna de
// las 3 llamadas fetch() externas de este archivo (Kapso conversations.get,
// el proveedor de IA, Kapso messages) tenía timeout propio — el fetch()
// global de Node no lo tiene por defecto, así que si el servidor remoto no
// respondía (o tardaba más de la cuenta), la función se quedaba esperando
// hasta que Lambda la mataba a la fuerza en su propio límite (30s) sin haber
// llegado a responderle nada ni a Kapso ni al cliente. Como Kapso además
// reintenta el webhook si no recibe un 200 en 10s (ver
// .agents/skills/integrate-whatsapp/references/webhooks-overview.md del
// panel), un colgado de 30s ya alcanzaba para que Kapso disparara una
// segunda invocación mucho antes — de ahí los duplicados.
//
// fetchConTimeout() corta cualquier fetch() a los FETCH_TIMEOUT_MS
// configurados acá, con AbortController — la función falla rápido y puede
// responder con el mensaje de fallback (o seguir con el teléfono solo en
// resolverThreadKey) en vez de agotar el timeout completo de Lambda.
//
// La llamada al modelo de IA tiene su propia cota más alta (GROQ_TIMEOUT_MS,
// heredada de cuando este valor se llamaba GEMINI_TIMEOUT_MS): un incidente
// real con el proveedor anterior (Gemini) mostró que 8s le quedaba corto
// incluso cuando SÍ iba a responder — abortaba de más. Se mantiene el mismo
// valor más alto para el proveedor actual (Groq) por las dudas, aunque Groq
// suele responder más rápido. Kapso (conversations.get y el envío del
// mensaje) se queda en 8s porque nunca mostró ese problema y suele responder
// rápido. Como un abort ya no reintenta (ver preguntarAGroq), el peor caso de
// esa función sigue siendo un solo intento de 20s, no 3×20s — la cuenta
// contra el timeout de 45s de la función sigue cerrando.
const FETCH_TIMEOUT_MS = 8000;
const GROQ_TIMEOUT_MS = 20000;

async function fetchConTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
  const response = await fetchConTimeout(url, {
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

// Lock compartido entre esta Lambda y WhatsApp-Agentico (ver
// src/lib/chat-ai-config.ts y src/app/api/messages/trigger-ai-reply/route.ts
// en ese repo) para que un mismo threadKey nunca reciba dos respuestas de IA
// independientes: hoy el webhook "kapso" le pega directo a esta Lambda en
// CADA mensaje entrante (sin pasar por el panel — ver README.md), mientras
// que el panel dispara su propia respuesta cuando un agente abre ese mismo
// chat con el último mensaje sin responder. Esto seguía siendo un riesgo
// real incluso después de migrar esta Lambda de Gemini a Groq (mismo
// proveedor que ya usaba el panel): dos invocaciones independientes de Groq
// respondiéndole al mismo mensaje es igual de problemático que uno de Gemini
// y uno de Groq — ninguno de los dos caminos sabía del otro, y cada uno solo
// se protegía contra reintentos de SU PROPIO camino (claimMessageId del lado
// del panel, la caché de threadKey de este archivo del lado de esta Lambda)
// — no había nada que impidiera a ambos responderle al mismo mensaje del
// cliente por separado.
//
// Vive en la MISMA tabla "conversaciones-ai-config" (fila aparte, prefijo
// "lock#" sobre el threadKey, para no chocar con la fila {threadKey,
// aiEnabled} de ese chat) en vez de una tabla nueva, a pedido explícito —
// ambos lados ya comparten esa tabla y ambos calculan el threadKey con el
// mismo formato (ver construirThreadKey() acá arriba y threadKeyFor() en
// src/lib/inbox-data.ts del panel: bsuid con prioridad si existe, si no el
// teléfono con solo dígitos, seguido de ":" + phoneNumberId) — confirmado
// carácter por carácter antes de implementar esto.
//
// El TTL nativo de DynamoDB (atributo `ttl`, si la tabla lo tiene habilitado)
// se agrega solo como limpieza de fondo, NO como el mecanismo real de
// expiración: ese TTL nativo puede tardar minutos u horas en barrer una fila
// vencida, nada garantiza que lo haga a los 30s exactos. La expiración real
// para el lock la hace la propia ConditionExpression de abajo, comparando
// `expiresAt` (epoch en milisegundos) contra la hora actual — así que aunque
// la fila del lock quede viva más tiempo del esperado, deja de bloquear a
// nadie apenas pasan los 30s.
const AI_REPLY_LOCK_TTL_MS = 30000;
const AI_REPLY_LOCK_PREFIX = 'lock#';

/**
 * Intenta tomar el lock de respuesta de IA para este threadKey. Devuelve
 * `true` si se obtuvo (nadie más lo tenía, o el que había ya expiró) — en
 * ese caso hay que liberarlo con liberarLockRespuestaIA() apenas se termine
 * de responder (o de fallar al intentarlo). Devuelve `false` si el otro
 * sistema (el panel) ya lo tiene tomado — en ese caso hay que abortar sin
 * llamarle a Groq ni mandar nada.
 */
async function adquirirLockRespuestaIA(threadKey) {
  const ahora = Date.now();
  try {
    await dynamoClient.send(new PutCommand({
      TableName: NOMBRE_TABLA_CONFIG,
      Item: {
        threadKey: `${AI_REPLY_LOCK_PREFIX}${threadKey}`,
        expiresAt: ahora + AI_REPLY_LOCK_TTL_MS,
        ttl: Math.floor((ahora + AI_REPLY_LOCK_TTL_MS) / 1000),
      },
      ConditionExpression: 'attribute_not_exists(threadKey) OR expiresAt < :ahora',
      ExpressionAttributeValues: { ':ahora': ahora },
    }));
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    // Falla de Dynamo en sí (no del lock): no le negamos la respuesta al
    // cliente por un problema de infraestructura ajeno al lock — mismo
    // criterio que ya usa obtenerAiEnabled() más arriba, pero acá el lado
    // seguro es DEJAR pasar (en el peor caso, si el otro lado también falla
    // igual, se duplica una respuesta en vez de no responder ninguna).
    console.error('No se pudo adquirir el lock de respuesta de IA en DynamoDB:', error);
    return true;
  }
}

async function liberarLockRespuestaIA(threadKey) {
  try {
    await dynamoClient.send(new DeleteCommand({
      TableName: NOMBRE_TABLA_CONFIG,
      Key: { threadKey: `${AI_REPLY_LOCK_PREFIX}${threadKey}` },
    }));
  } catch (error) {
    console.error('No se pudo liberar el lock de respuesta de IA en DynamoDB:', error);
  }
}

// Migración de Gemini a Groq (mismo proveedor que ya usa el panel, ver
// generateAIResponse en WhatsApp-Agentico/src/lib/ai-client.ts): este prompt
// de sistema es una copia TEXTUAL del de ese archivo, a propósito — para que
// ambos lados (panel y esta Lambda) respondan con el mismo tono ahora que
// hablan con el mismo modelo. Si el de ai-client.ts cambia, hay que traer el
// cambio acá también a mano (no hay ningún mecanismo que los mantenga
// sincronizados automáticamente, son dos repos separados). A diferencia de
// la API de Gemini (que aceptaba esto en un campo separado,
// "systemInstruction"), el formato de OpenAI/Groq lo manda como un mensaje
// más dentro de "messages", con role: "system", primero en la lista.
const INSTRUCCION_SISTEMA =
  'Eres un asistente de atención al cliente por WhatsApp. Responde en español, ' +
  'de forma amable, clara y breve. No inventes información que no conozcas. ' +
  // Restricción "solo temas de la empresa" — este texto debe ser IDÉNTICO al
  // del system prompt en WhatsApp-Agentico/src/lib/ai-client.ts (repo
  // aparte), para que el bot se comporte igual sin importar cuál de los dos
  // sistemas responda (ambos usan Groq). Si se edita acá, hay que editarlo a
  // mano también del otro lado — no hay nada que los sincronice.
  'Solo debes responder preguntas relacionadas con la empresa: sus productos ' +
  'o servicios, pedidos, catálogo, precios, envíos, o soporte al cliente. Si ' +
  'el cliente pregunta algo que no tiene relación con la empresa (temas ' +
  'personales, opiniones generales u otros temas ajenos al negocio), ' +
  'respóndele con amabilidad que solo puedes ayudarlo con temas ' +
  'relacionados a la empresa, sin sonar cortante ni robótico. ' +
  'A continuación verás el historial reciente de esta conversación (mensajes ' +
  'del cliente y tus propias respuestas anteriores) — úsalo para entender el ' +
  'contexto. No vuelvas a saludar ("Hola", "Buenos días", etc.) si la ' +
  'conversación ya estaba en curso; solo saluda si de verdad es el primer ' +
  'mensaje del historial.';

/**
 * El historial se guarda (y se sigue guardando, sin migrar lo ya escrito en
 * "conversaciones-whatsapp") en el formato que usaba Gemini —
 * {role: 'user'|'model', parts: [{text}]} — así que acá se traduce al vuelo
 * al formato {role, content} que espera la API de OpenAI/Groq, solo para
 * armar este request puntual. 'model' (Gemini) se mapea a 'assistant'
 * (OpenAI/Groq); 'user' se mantiene igual. Si un turno tuviera más de una
 * "part" (no pasa hoy, pero por las dudas), se concatenan.
 */
function historialAFormatoGroq(historial) {
  return historial.map((turno) => ({
    role: turno.role === 'model' ? 'assistant' : 'user',
    content: (turno.parts ?? []).map((parte) => parte.text ?? '').join(''),
  }));
}

async function preguntarAGroq(apiKey, historial) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';

  for (let intento = 1; intento <= 3; intento++) {
    // Diagnóstico: visibilidad de en qué intento estamos y qué pasó en cada
    // uno, para saber si el fallback sale desde el primer intento o recién
    // después de agotar los 3 — sin esto, el log solo mostraba el texto
    // final de la respuesta (o del fallback), sin ninguna pista del motivo.
    console.log(`Groq: intento ${intento} de 3...`);

    let data;
    let response;
    try {
      response = await fetchConTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: INSTRUCCION_SISTEMA },
            ...historialAFormatoGroq(historial),
          ],
        }),
      }, GROQ_TIMEOUT_MS);
      data = await response.json();
    } catch (error) {
      // Se cortó por nuestro propio timeout (AbortError) o falló la red —
      // a diferencia del 503 de más abajo, acá NO se reintenta: si esta
      // llamada ya tardó demasiado, reintentar solo vuelve a arriesgar el
      // mismo presupuesto de tiempo que causó el timeout de 30s original.
      // Se responde el fallback ya, sin gastar los intentos restantes.
      const fueTimeoutPropio = error.name === 'AbortError';
      console.error(
        `Groq: intento ${intento} de 3 falló con excepción` +
        (fueTimeoutPropio ? ` (TIMEOUT propio a los ${GROQ_TIMEOUT_MS}ms, GROQ_TIMEOUT_MS)` : ' (red u otro error, no fue nuestro timeout)') +
        ` — name=${error.name}, message=${error.message}`
      );
      return 'Lo siento, no pude generar una respuesta en este momento.';
    }

    if (data.choices?.[0]?.message?.content) {
      console.log(`Groq: intento ${intento} de 3 OK (status HTTP ${response.status})`);
      return data.choices[0].message.content;
    }

    // Groq respondió (no hubo excepción ni timeout) pero sin texto válido en
    // choices[0].message.content — logueamos el status HTTP y el body
    // completo para ver si vino un error (429, 503, ...) o algún motivo
    // explícito (p.ej. finish_reason distinto de "stop") antes de decidir si
    // se reintenta.
    console.error(
      `Groq: intento ${intento} de 3 sin texto válido — status HTTP ${response.status}, body=${JSON.stringify(data)}`
    );

    // A diferencia de Gemini (que traía un código numérico en
    // data.error.code), el body de error de Groq no trae un código — solo
    // {error: {message, type}} (p.ej. type: "service_unavailable_error") —
    // así que el 503 que dispara el reintento se lee del STATUS HTTP de la
    // respuesta, no del body. Confirmado contra la documentación oficial de
    // Groq (console.groq.com/docs/errors) antes de implementar esto.
    if (response.status === 503 && intento < 3) {
      console.log(`Groq: intento ${intento} de 3 fue 503, esperando 1.5s antes de reintentar...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    return 'Lo siento, no pude generar una respuesta en este momento.';
  }
}

async function enviarRespuestaWhatsApp(apiKey, phoneNumberId, numeroDestino, texto) {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`;
  const response = await fetchConTimeout(url, {
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

    const groqKey = await obtenerParametro('/whatsapp-agente/groq-api-key');

    const historialAnterior = await obtenerHistorial(numero);

    const historialActualizado = [
      ...historialAnterior,
      { role: 'user', parts: [{ text: textoRecibido }] },
    ];

    // Corrección de "esta Lambda y el panel responden el mismo mensaje por
    // separado": si el panel ya tiene el lock (está respondiendo este mismo
    // threadKey por su propio camino, ver trigger-ai-reply en el otro repo),
    // abortamos ACÁ, antes de llamarle a Groq y de escribir cualquier fallback.
    if (!(await adquirirLockRespuestaIA(threadKey))) {
      console.log(`Lock de respuesta de IA ya tomado para threadKey=${threadKey} (probablemente el panel ya está respondiendo este mensaje)`);
      return { statusCode: 200, body: JSON.stringify({ status: 'lock_no_disponible' }) };
    }

    try {
      const respuestaIA = await preguntarAGroq(groqKey, historialActualizado);
      console.log(`Respuesta de Groq: "${respuestaIA}"`);

      historialActualizado.push({ role: 'model', parts: [{ text: respuestaIA }] });
      await guardarHistorial(numero, historialActualizado);

      await enviarRespuestaWhatsApp(kapsoKey, phoneNumberId, numero, respuestaIA);
    } finally {
      // Se libera tanto si se respondió bien como si preguntarAGroq,
      // guardarHistorial o enviarRespuestaWhatsApp fallaron — para no dejar
      // el threadKey bloqueado 30s de más ante una falla real, bloqueando
      // sin necesidad el próximo mensaje genuino del cliente.
      await liberarLockRespuestaIA(threadKey);
    }

    return { statusCode: 200, body: JSON.stringify({ status: 'respondido' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 200, body: JSON.stringify({ status: 'error', detalle: error.message }) };
  }
};
