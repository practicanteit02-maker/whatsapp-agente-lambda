# whatsapp-agente-lambda

Función AWS Lambda que recibe los mensajes de WhatsApp (vía Kapso) y responde automáticamente con IA (Google Gemini), solo si está activada para ese chat.

## Qué hace

1. Kapso reenvía aquí cada mensaje entrante.
2. Consulta la tabla `conversaciones-ai-config` — si la IA no está activada para ese chat, no hace nada más.
3. Si está activada, arma el historial reciente, le pregunta a Gemini, y envía la respuesta por Kapso.

## Tablas DynamoDB

- `conversaciones-whatsapp` (clave `numero_telefono`) — historial de conversación con la IA.
- `conversaciones-ai-config` (clave `threadKey`) — si la IA debe responder. **Compartida con el panel** [`WhatsApp-Agentico`](../WhatsApp-Agentico): el panel escribe ahí, esta Lambda lee.

## Relación con el panel

No hay dependencia de código entre los dos repos — solo se comunican a través de esa tabla compartida. El webhook de Kapso apunta directo a esta Lambda, no al panel.

## Despliegue

Automático vía GitHub Actions: cada push a `main` actualiza la función `whatsapp-agente-test` en `us-east-2`. Pese al nombre, **es producción real**, no un entorno de pruebas.

## Variables 

- `/whatsapp-agente/gemini-api-key`
- `/whatsapp-agente/kapso-api-key`
