export interface Env {
  DB: D1Database;
  TASK_QUEUE: Queue<TaskMessage>;
  TRACKING_QUEUE: Queue<TaskMessage>;
  ZALO_INBOX_QUEUE: Queue<TaskMessage>;
  OAUTH_COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  MCP_URL: string;
  MCP_SCOPE: string;
  DEFAULT_ADVERTISER_ID: string;
  DEFAULT_STORE_CODE: string;
  TIMEZONE: string;
  PUBLIC_BASE_URL: string;
  ADMIN_PASSWORD: string;
  TOKEN_ENCRYPTION_KEY: string;
  ZALO_BOT_TOKEN?: string;
  ZALO_GROUP_CHAT_ID?: string;
  ZALO_WEBHOOK_SECRET?: string;
  ZALO_ADVERTISER_ID?: string;
  ZALO_STORE_CODE?: string;
  ZALO_STORE_ID?: string;
  ZALO_OPERATIONS_BOT_TOKEN?: string;
  ZALO_OPERATIONS_GROUP_CHAT_ID?: string;
  ZALO_OPERATIONS_GROUP_NAME?: string;
  ZALO_OPERATIONS_WEBHOOK_SECRET?: string;
  ZALO_ORDER_BOT_TOKEN?: string;
  ZALO_ORDER_GROUP_CHAT_ID?: string;
  ZALO_ORDER_GROUP_CHAT_NAME?: string;
  TIKTOK_SHOP_APP_KEY?: string;
  TIKTOK_SHOP_APP_SECRET?: string;
  TIKTOK_SHOP_SERVICE_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  GOOGLE_BACKUP_SPREADSHEET_ID?: string;
}

export type TaskMessage =
  | { type: 'hourly-dispatch'; reportDate: string; reportHour: number; backupDate?: string }
  | { type: 'scheduled-report'; reportDate: string; reportHour: number }
  | { type: 'operations-daily-report'; reportDate: string; operationsDate?: string; mode: 'DAILY' | 'REALTIME'; chatId?: string; eventId?: string }
  | { type: 'order-bot-report'; reportDate: string; reportTime: string; force?: boolean }
  | { type: 'zalo-poll' }
  | { type: 'zalo-webhook-ensure' }
  | { type: 'zalo-video'; eventId: number }
  | { type: 'zalo-video-day'; eventId: number; reportDate: string }
  | { type: 'zalo-video-finalize'; eventId: number }
  | { type: 'zalo-video-recover' }
  | { type: 'tracking-sync'; orderId: string; shopCipher: string }
  | { type: 'sheet-backup'; reportDate: string };

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId?: string;
  tokenType?: string;
  scope?: string;
}

export interface SellerTokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  openId?: string;
  sellerName?: string;
  grantedScopes?: string[];
}

export interface ProductContext {
  campaignId: string;
  itemGroupId: string;
  campaignActive?: boolean;
}

export interface MetricSet {
  cost: number;
  orders: number;
  costPerOrder: number;
  grossRevenue: number;
  roi: number;
  traffic: number;
  impressions: number;
}

export interface McpSession {
  id?: string;
  requestId: number;
  toolNames?: string[];
}

export interface McpRow {
  dimensions?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}
