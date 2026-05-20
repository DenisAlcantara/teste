import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EnvVars } from '../../../config/env.validation';

export const DYNAMO_DOCUMENT_CLIENT = Symbol('DYNAMO_DOCUMENT_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: DYNAMO_DOCUMENT_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const client = new DynamoDBClient({
          region: config.get('AWS_REGION', { infer: true }),
          endpoint: config.get('DYNAMODB_ENDPOINT', { infer: true }),
          credentials: {
            accessKeyId: config.get('AWS_ACCESS_KEY_ID', { infer: true }),
            secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', { infer: true }),
          },
        });
        return DynamoDBDocumentClient.from(client, {
          marshallOptions: {
            removeUndefinedValues: true,
            convertEmptyValues: false,
          },
        });
      },
    },
  ],
  exports: [DYNAMO_DOCUMENT_CLIENT],
})
export class DynamoModule {}
