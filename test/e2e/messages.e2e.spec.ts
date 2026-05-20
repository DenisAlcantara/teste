import 'reflect-metadata';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { MessageEventPublisher } from '../../src/messages/kafka.publisher';

const TABLES = ['messages-table', 'idempotency-table'];

const raw = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

async function dropAll(): Promise<void> {
  for (const TableName of TABLES) {
    try {
      await raw.send(new DeleteTableCommand({ TableName }));
    } catch (e) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
  }
}

async function createMessagesTable(): Promise<void> {
  await raw.send(
    new CreateTableCommand({
      TableName: 'messages-table',
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1-sender',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2-date',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
}

async function createSimpleTable(name: string): Promise<void> {
  await raw.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }],
    }),
  );
}

describe('Messages API (e2e)', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '0',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
      MESSAGES_TABLE: 'messages-table',
      IDEMPOTENCY_TABLE: 'idempotency-table',
      KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9094',
      KAFKA_CLIENT_ID: 'messages-api-e2e',
      KAFKA_GROUP_ID: 'messages-worker-e2e',
      KAFKA_EVENTS_TOPIC: 'message-events',
      KAFKA_EVENTS_DLQ_TOPIC: 'message-events-dlq',
      KAFKA_CONSUMER_MAX_ATTEMPTS: '3',
      KAFKA_CONSUMER_RETRY_BASE_MS: '50',
      KAFKA_PRODUCER_ACKS: '-1',
      DEMO_PASSWORD: 'any',
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_ACCESS_TTL: '15m',
      IDEMPOTENCY_TTL_SECONDS: '86400',
    });

    await dropAll();
    await createMessagesTable();
    await createSimpleTable('idempotency-table');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MessageEventPublisher)
      .useValue({ publish: jest.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: `user-${Date.now()}`, password: 'any' })
      .expect(200);
    accessToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await dropAll();
  });

  it('requires JWT on /messages', async () => {
    await request(app.getHttpServer()).post('/messages').send({ content: 'a', sender: 'b' }).expect(401);
  });

  it('creates a message', async () => {
    const res = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', `key-${Date.now()}`)
      .send({ content: 'hello', sender: 'alice' })
      .expect(201);

    expect(res.body).toMatchObject({
      content: 'hello',
      sender: 'alice',
      status: 'enviado',
    });
    expect(res.body.id).toEqual(expect.any(String));
  });

  it('returns same response for repeated Idempotency-Key', async () => {
    const key = `key-${Date.now()}`;
    const a = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ content: 'unique-1', sender: 'alice' })
      .expect(201);

    const b = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ content: 'unique-2', sender: 'alice' })
      .expect(201);

    // Key-only: same key returns cached response regardless of body.
    expect(b.body.id).toBe(a.body.id);
  });

  it('replays same 400 response for repeated Idempotency-Key on validation errors', async () => {
    const key = `invalid-key-${Date.now()}`;

    const first = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ content: '', sender: 'alice' })
      .expect(400);

    const second = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send({ content: '', sender: 'alice' })
      .expect(400);

    expect(second.body.statusCode).toBe(first.body.statusCode);
    expect(second.body.error).toBe(first.body.error);
    expect(second.body.message).toEqual(first.body.message);
    expect(second.body.path).toBe(first.body.path);
  });

  it('enforces status state machine', async () => {
    const created = await request(app.getHttpServer())
      .post('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ content: 'state-machine', sender: 'alice' })
      .expect(201);

    // SENT -> READ skips RECEIVED, should be 409
    await request(app.getHttpServer())
      .patch(`/messages/${created.body.id}/status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'lido' })
      .expect(409);

    await request(app.getHttpServer())
      .patch(`/messages/${created.body.id}/status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'recebido' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/messages/${created.body.id}/status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'lido' })
      .expect(200);
  });

  it('rejects find with neither sender nor date-range', async () => {
    await request(app.getHttpServer())
      .get('/messages')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('rejects find with both sender and date-range', async () => {
    await request(app.getHttpServer())
      .get('/messages')
      .query({
        sender: 'alice',
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('rejects cursor on date-range find', async () => {
    await request(app.getHttpServer())
      .get('/messages')
      .query({
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31T00:00:00.000Z',
        cursor: 'abc',
      })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });
});
