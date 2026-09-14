# whatsapp-agente-lambda

Función AWS Lambda que recibe los mensajes de WhatsApp (vía Kapso) y responde automáticamente con IA (Groq), solo si está activada para ese chat.

## Qué hace

1. Kapso reenvía aquí cada mensaje entrante.
2. Consulta la tabla `conversaciones-ai-config` — si la IA no está activada para ese chat, no hace nada más.
3. Si está activada, arma el historial reciente, le pregunta a Groq, y envía la respuesta por Kapso.

Nota: hasta septiembre de 2026 esta función usaba Google Gemini — se migró a
Groq (mismo proveedor que ya usa el panel [`WhatsApp-Agentico`](../WhatsApp-Agentico)
para su propia respuesta automática) para evitar el límite de cuota gratuita
mucho más bajo de Gemini. El historial guardado en `conversaciones-whatsapp`
sigue en el formato que usaba Gemini (`{role: 'user'|'model', parts:
[{text}]}`) — no se migró, solo se traduce al vuelo al formato de Groq al
armar cada request (ver `historialAFormatoGroq` en `index.mjs`).

## Tablas DynamoDB

- `conversaciones-whatsapp` (clave `numero_telefono`) — historial de conversación con la IA.
- `conversaciones-ai-config` (clave `threadKey`) — si la IA debe responder, y también el lock compartido de "no responder el mismo mensaje dos veces" (filas `lock#<threadKey>`, ver `adquirirLockRespuestaIA` en `index.mjs`). **Compartida con el panel** [`WhatsApp-Agentico`](../WhatsApp-Agentico): ambos lados leen y escriben ahí.

## Relación con el panel

No hay dependencia de código entre los dos repos — solo se comunican a través de esa tabla compartida. El webhook de Kapso apunta directo a esta Lambda, no al panel.

## Despliegue

Automático vía GitHub Actions: cada push a `main` actualiza la función `whatsapp-agente-test` en `us-east-2`. Pese al nombre, **es producción real**, no un entorno de pruebas.

## Variables 

- `/whatsapp-agente/groq-api-key`
- `/whatsapp-agente/kapso-api-key`
