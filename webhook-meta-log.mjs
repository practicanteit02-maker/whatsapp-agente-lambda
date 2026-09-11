import crypto from 'crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

// Handler de la funcionalidad "Mostrar cuando un cliente edita un mensaje" —
// procesa el webhook tipo "meta" (payload crudo de Meta, sin normalizar) que
// Kapso manda en paralelo al webhook "kapso" ya existente.
//
// 100% AISLADO de index.mjs: archivo separado, sin importar ni ser importado
// por el handler actual (el que atiende mensajes con la IA). No toca
// conversaciones-whatsapp ni conversaciones-ai-config, no llama a Gemini ni
// envía mensajes — solo lee/escribe la tabla nueva "ediciones-panel". Corre
// en su propia función Lambda separada (nunca en whatsapp-agente-test, la
// función de producción).
//
// Firma — CONFIRMADO con un payload real (ya no es una suposición): Kapso
// firma los webhooks tipo "meta" con el mismo esquema que documenta para los
// tipo "kapso", header `X-Webhook-Signature` = HMAC-SHA256(secreto, body
// crudo) en hex — la suposición inicial de `X-Hub-Signature-256` (la
// convención nativa de Meta) estaba mal; Kapso re-firma con el secreto que
// nosotros elegimos al registrar el webhook (ver secret_key en la respuesta
// de creación), no reenvía la firma original de Meta.
const NOMBRE_HEADER_FIRMA = 'x-webhook-signature';
const SSM_PARAM_SECRETO = '/whatsapp-agente/meta-webhook-secret';
const TABLA_EDICIONES = 'ediciones-panel';

const ssmClient = new SSMClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function obtenerSecreto() {
  const command = new GetParameterCommand({ Name: SSM_PARAM_SECRETO, WithDecryption: true });
  const response = await ssmClient.send(command);
  return response.Parameter?.Value;
}

function obtenerHeader(headers, nombre) {
  if (!headers) return undefined;
  const nombreMinuscula = nombre.toLowerCase();
  for (const [clave, valor] of Object.entries(headers)) {
    if (clave.toLowerCase() === nombreMinuscula) return valor;
  }
  return undefined;
}

function verificarFirma(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const firmaEsperada = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const bufferRecibido = Buffer.from(signatureHeader, 'utf8');
  const bufferEsperado = Buffer.from(firmaEsperada, 'utf8');

  if (bufferRecibido.length !== bufferEsperado.length) return false;
  return crypto.timingSafeEqual(bufferRecibido, bufferEsperado);
}

// Misma fórmula que construirThreadKey() en index.mjs y threadKeyFor() del
// panel (src/lib/inbox-data.ts) — duplicada acá a propósito, no importada,
// para que este archivo se mantenga 100% aislado (mismo criterio que ya
// usamos con auditoria.ts/respuestas-metrics.ts en el panel: cada módulo se
// basta solo, sin acoplarse a otro archivo de producción).
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

function aIso(timestampSegundos) {
  const numero = Number(timestampSegundos);
  return Number.isFinite(numero) ? new Date(numero * 1000).toISOString() : new Date().toISOString();
}

async function guardarEdicion({ threadKey, messageId, texto, editadoEn }) {
  await dynamoClient.send(
    new PutCommand({
      TableName: TABLA_EDICIONES,
      Item: { threadKey, messageId, texto, editadoEn },
    })
  );
}

/**
 * Un mensaje editado llega, dentro de value.messages[], con type: "edit" y
 * un bloque `edit` propio — mismo id del wamid ORIGINAL en
 * edit.original_message_id (no en el `id` de nivel superior, que es el id
 * del evento de edición en sí, no del mensaje). El texto nuevo viaja en
 * edit.message.text.body (por ahora solo se vieron ediciones de texto).
 */
function esMensajeDeEdicion(mensaje) {
  return mensaje?.type === 'edit' && mensaje?.edit?.original_message_id;
}

async function procesarMensajeEditado(mensaje, value) {
  const phoneNumberId = value?.metadata?.phone_number_id;
  const from = mensaje.from;
  // Defensivo, mismo criterio que ya aplicamos en el panel (ver el bug de
  // threadKey con contactos bsuid+teléfono): si Meta manda el contacto
  // resuelto acá, se prioriza sobre el teléfono al armar la clave.
  const businessScopedUserId = value?.contacts?.[0]?.user_id;
  const texto = mensaje.edit?.message?.text?.body;

  if (!phoneNumberId || !from || !texto) {
    console.error('EDICION_INCOMPLETA: faltan datos, se ignora', {
      tienePhoneNumberId: Boolean(phoneNumberId),
      tieneFrom: Boolean(from),
      tieneTexto: Boolean(texto),
    });
    return;
  }

  const threadKey = construirThreadKey(phoneNumberId, from, businessScopedUserId);
  const messageId = mensaje.edit.original_message_id;
  const editadoEn = aIso(mensaje.timestamp);

  await guardarEdicion({ threadKey, messageId, texto, editadoEn });
  console.log('EDICION_GUARDADA', { threadKey, messageId, editadoEn });
}

export const handler = async (event) => {
  try {
    // event.body llega en texto salvo que Lambda lo marque como base64 — la
    // firma se calcula sobre los bytes crudos, antes de tocar el JSON.
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    const signatureHeader = obtenerHeader(event.headers, NOMBRE_HEADER_FIRMA);

    const secret = await obtenerSecreto();
    if (!secret) {
      console.error('SSM_SECRETO_NO_CONFIGURADO: falta el parámetro', SSM_PARAM_SECRETO);
      return { statusCode: 500, body: JSON.stringify({ status: 'secreto_no_configurado' }) };
    }

    if (!verificarFirma(rawBody, signatureHeader, secret)) {
      console.error('FIRMA_INVALIDA', { tieneHeader: Boolean(signatureHeader) });
      return { statusCode: 401, body: JSON.stringify({ status: 'firma_invalida' }) };
    }

    const body = JSON.parse(rawBody);

    // Envoltorio crudo de Meta: entry[].changes[].value.messages[] — se
    // recorre defensivamente por si alguna vez llega más de un entry/change/
    // mensaje junto, aunque "meta" no hace buffering según la doc de Kapso.
    const entries = Array.isArray(body.entry) ? body.entry : [];
    let procesados = 0;

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value ?? {};
        const mensajes = Array.isArray(value.messages) ? value.messages : [];
        for (const mensaje of mensajes) {
          if (!esMensajeDeEdicion(mensaje)) continue;
          await procesarMensajeEditado(mensaje, value);
          procesados += 1;
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ status: 'ok', ediciones_procesadas: procesados }) };
  } catch (error) {
    console.error('Error en webhook-meta-log:', error);
    // 200 igual: evita que Kapso reintente sin parar por un error nuestro.
    return { statusCode: 200, body: JSON.stringify({ status: 'error', detalle: error.message }) };
  }
};
