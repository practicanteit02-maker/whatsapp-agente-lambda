import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { adquirirLockRespuestaIA, liberarLockRespuestaIA } from '../index.mjs';

// Tests del lock de respuesta de IA — ver el comentario largo junto a
// adquirirLockRespuestaIA en index.mjs para el diseño completo (por qué
// existe, y por qué vive en su propia tabla "locks-respuesta-ia").
//
// Mockean DynamoDBDocumentClient.prototype.send con el mock.method NATIVO de
// node:test (t.mock, ver cada test) — sin ninguna dependencia nueva de test.
// Patchar el PROTOTIPO (no una instancia) alcanza porque el `dynamoClient` de
// index.mjs es una instancia de esa misma clase: mientras dure el mock,
// cualquier .send() que haga (sin importar cuándo se construyó la instancia)
// pasa por esta implementación falsa. t.mock restaura el método original
// automáticamente al terminar cada test, así que no hace falta limpiar a mano
// entre tests ni preocuparse de que se pisen entre sí.
//
// Las 3 devDependencies del SDK de AWS en package.json (client-dynamodb,
// client-ssm, lib-dynamodb) SÍ son dependencias reales acá — no por el test
// runner (ese sigue siendo node:test nativo), sino porque: (a) este test
// necesita las clases reales de @aws-sdk/lib-dynamodb (DynamoDBDocumentClient,
// PutCommand, DeleteCommand) para mockear el método correcto e inspeccionar
// qué Command se armó, y (b) importar index.mjs completo (para llegar a
// adquirirLockRespuestaIA/liberarLockRespuestaIA) ejecuta también sus otros
// imports de nivel de módulo (@aws-sdk/client-dynamodb, @aws-sdk/client-ssm),
// aunque este test no los use directamente. En producción la Lambda las sigue
// recibiendo del runtime de AWS, no de node_modules (ver la exclusión de
// node_modules/package.json en .github/workflows/deploy.yml) — estas
// devDependencies existen solo para poder correr los tests en local/CI.

const THREAD_KEY = '123456:5731234567';
const TABLA_LOCKS = 'locks-respuesta-ia'; // debe coincidir con NOMBRE_TABLA_LOCKS en index.mjs
const PREFIJO_LOCK = 'lock#'; // debe coincidir con AI_REPLY_LOCK_PREFIX en index.mjs

function crearError(nombre, mensaje) {
  const error = new Error(mensaje);
  error.name = nombre;
  return error;
}

test('adquirirLockRespuestaIA: Put resuelve -> true, usando la tabla y la clave correctas', async (t) => {
  const sendMock = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    assert.ok(command instanceof PutCommand, 'debe usar PutCommand para adquirir el lock');
    assert.equal(command.input.TableName, TABLA_LOCKS);
    assert.equal(command.input.Item.threadKey, `${PREFIJO_LOCK}${THREAD_KEY}`);
    return {};
  });

  const resultado = await adquirirLockRespuestaIA(THREAD_KEY);

  assert.equal(resultado, true);
  assert.equal(sendMock.mock.callCount(), 1);
});

test('adquirirLockRespuestaIA: ConditionalCheckFailedException -> false (el otro sistema ya tiene el lock)', async (t) => {
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    throw crearError('ConditionalCheckFailedException', 'The conditional request failed');
  });

  const resultado = await adquirirLockRespuestaIA(THREAD_KEY);

  assert.equal(resultado, false);
});

test('adquirirLockRespuestaIA: cualquier OTRO error de Dynamo -> true ("falla abierto")', async (t) => {
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    throw new Error('ProvisionedThroughputExceededException (o cualquier otra falla de infraestructura ajena al lock)');
  });

  const resultado = await adquirirLockRespuestaIA(THREAD_KEY);

  // El caso más importante de los tres: un problema de Dynamo que no sea el
  // lock en sí (permisos, throughput, tabla caída, timeout...) no debe
  // negarle la respuesta al cliente — ver el comentario junto al catch de
  // adquirirLockRespuestaIA en index.mjs. Es también la rama más fácil de
  // invertir sin querer en una edición futura, de ahí que sea la que más
  // vale la pena fijar con un test.
  assert.equal(resultado, true);
});

test('liberarLockRespuestaIA: Delete resuelve -> no lanza, usando la tabla y la clave correctas', async (t) => {
  const sendMock = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    assert.ok(command instanceof DeleteCommand, 'debe usar DeleteCommand para liberar el lock');
    assert.equal(command.input.TableName, TABLA_LOCKS);
    assert.equal(command.input.Key.threadKey, `${PREFIJO_LOCK}${THREAD_KEY}`);
    return {};
  });

  await assert.doesNotReject(() => liberarLockRespuestaIA(THREAD_KEY));
  assert.equal(sendMock.mock.callCount(), 1);
});

test('liberarLockRespuestaIA: el Delete falla -> nunca lanza (no debe bloquear el resto del flujo)', async (t) => {
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
    throw new Error('Dynamo no responde');
  });

  // liberarLockRespuestaIA se llama siempre en un `finally` (ver el handler
  // en index.mjs) — si lanzara acá, se comería cualquier excepción real que
  // haya pasado antes en el try. Por eso el contrato es "nunca lanza",
  // pase lo que pase con el Delete.
  await assert.doesNotReject(() => liberarLockRespuestaIA(THREAD_KEY));
});
