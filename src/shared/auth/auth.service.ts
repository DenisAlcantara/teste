import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { EnvVars } from '../../config/env.validation';
import { JwtPayload } from './jwt.strategy';

export interface AuthTokens {
  accessToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async login(username: string, password: string): Promise<AuthTokens> {
    const expected = this.config.get('DEMO_PASSWORD', { infer: true });
    if (!username || password !== expected) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.issueToken({ sub: randomUUID(), username });
  }

  private async issueToken(payload: JwtPayload): Promise<AuthTokens> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: accessTtl,
    });
    return { accessToken, expiresIn: parseTtlSeconds(accessTtl) };
  }
}

function parseTtlSeconds(ttl: string): number {
  const m = ttl.match(/^(\d+)([smhd])$/);
  if (!m) return 900;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return 900;
  }
}
