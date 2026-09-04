import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ssmClient = new SSMClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const NOMBRE_TABLA = 'conversaciones-whatsapp';
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

async function preguntarAGemini(apiKey, historial) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  for (let intento = 1; intento <= 3; intento++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: historial }),
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

    if (body.message?.kapso?.direction === 'outbound') {
      return { statusCode: 200, body: JSON.stringify({ status: 'ignorado_outbound' }) };
    }

    if (!textoRecibido || !numero || !phoneNumberId) {
      return { statusCode: 200, body: JSON.stringify({ status: 'ignorado' }) };
    }

    console.log(`Mensaje de ${numero}: "${textoRecibido}"`);

    const geminiKey = await obtenerParametro('/whatsapp-agente/gemini-api-key');
    const kapsoKey = await obtenerParametro('/whatsapp-agente/kapso-api-key');

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
