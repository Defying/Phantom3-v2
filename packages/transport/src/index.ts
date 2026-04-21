import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

export type SocksProxyProtocol = 'socks5' | 'socks5h';

export type SocksProxyConfig = {
  url: string;
  protocol: SocksProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  remoteDns: boolean;
};

export type JsonRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export type OutboundTransportOptions = {
  proxy?: SocksProxyConfig | null;
};

function trimTrailingColon(value: string): string {
  return value.endsWith(':') ? value.slice(0, -1) : value;
}

export function parseSocksProxyUrl(value: string): SocksProxyConfig {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('SOCKS proxy URL must not be empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid SOCKS proxy URL: ${trimmed}`);
  }

  const protocol = trimTrailingColon(parsed.protocol);
  if (protocol !== 'socks5' && protocol !== 'socks5h') {
    throw new Error(`Unsupported proxy protocol "${protocol}". Use socks5:// or socks5h://.`);
  }

  if (parsed.hostname.length === 0) {
    throw new Error('SOCKS proxy URL must include a hostname.');
  }

  const port = parsed.port.length > 0 ? Number(parsed.port) : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SOCKS proxy port in ${trimmed}`);
  }

  return {
    url: parsed.toString(),
    protocol,
    host: parsed.hostname,
    port,
    username: parsed.username.length > 0 ? decodeURIComponent(parsed.username) : null,
    password: parsed.password.length > 0 ? decodeURIComponent(parsed.password) : null,
    remoteDns: protocol === 'socks5h'
  };
}

export class OutboundTransport {
  readonly proxy: SocksProxyConfig | null;
  readonly socketAgent: SocksProxyAgent | null;

  private readonly http = axios.create({
    proxy: false,
    validateStatus: () => true
  });

  constructor(options: OutboundTransportOptions = {}) {
    this.proxy = options.proxy ?? null;
    this.socketAgent = this.proxy ? new SocksProxyAgent(this.proxy.url) : null;
  }

  async getJson<T>(url: string, options: JsonRequestOptions = {}): Promise<T> {
    const response = await this.http.get<T>(url, {
      signal: options.signal,
      timeout: options.timeoutMs,
      headers: options.headers,
      responseType: 'json',
      httpAgent: this.socketAgent ?? undefined,
      httpsAgent: this.socketAgent ?? undefined
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.data;
  }

  webSocketOptions(): { agent?: SocksProxyAgent } {
    return this.socketAgent ? { agent: this.socketAgent } : {};
  }
}
