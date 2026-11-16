import {
  bigserial,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users.js';
import { oauthClients } from './oauth.js';

// ---------------------------------------------------------------------------
// notifications — in-app notifications per user
// ---------------------------------------------------------------------------
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('idx_notifications_user_created').on(table.userId, table.createdAt.desc()),
    userUnreadIdx: index('idx_notifications_user_unread')
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL`),
  }),
);

// ---------------------------------------------------------------------------
// user_bans — unified ban log (admin suspensions + auto-lockouts)
// ---------------------------------------------------------------------------
export const userBans = pgTable(
  'user_bans',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['manual', 'lockout'] }).notNull(),
    reason: text('reason'),
    // NULL for system-issued lockouts
    issuedBy: integer('issued_by').references(() => users.id, { onDelete: 'set null' }),
    // Source IP a credential-spray `lockout` was scoped to. NULL for per-user
    // lockouts and manual bans. When set, `/internal/auth/verify` rejects EVERY
    // FTPS auth from this IP (any username) until the row expires or an admin
    // cancels it — cancelling clears the block since the check filters on
    // cancelled_at IS NULL. The row is still attached to a real user_id (the
    // account whose failed attempt tripped the per-IP threshold) so it shows in
    // that user's ban list and is cancellable via DELETE /users/:uuid/bans/:id.
    sourceIp: inet('source_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // The login a `lockout` blocks: 'web' (HTTP sign-in) or 'ftp' (camera
    // FTP/FTPS logins — the per-IP spray lockout included). NULL on manual bans,
    // which block everything, and on lockouts written before the two channels
    // were separated; such a lockout blocks both until it expires.
    channel: text('channel', { enum: ['web', 'ftp'] }),
    // What a `lockout` row is keyed on: 'account' (every source), 'account_ip'
    // (this account from `source_ip` only) or 'ip' (the credential-spray block of
    // an address, every username). NULL on manual bans and on rows written
    // before the column: read as 'account' without a source_ip, 'ip' with one.
    scope: text('scope', { enum: ['account', 'account_ip', 'ip'] }),
  },
  (table) => ({
    activeBanIdx: index('idx_user_bans_active')
      .on(table.userId, table.expiresAt)
      .where(sql`${table.cancelledAt} IS NULL`),
    // Hot path: `isIpLocked` looks up active lockouts by source IP on every
    // FTPS auth attempt. Partial index keeps it cheap and only indexes the
    // rare IP-scoped rows.
    activeIpBanIdx: index('idx_user_bans_ip_active')
      .on(table.sourceIp, table.expiresAt)
      .where(sql`${table.cancelledAt} IS NULL`),
    typeCheck: check('user_bans_type_check', sql`${table.type} IN ('manual', 'lockout')`),
    channelCheck: check('user_bans_channel_check', sql`${table.channel} IN ('web', 'ftp')`),
  }),
);

// ---------------------------------------------------------------------------
// ip_login_attempts — per-source-IP failed-login counter (credential-spray)
//
// The per-user lockout (users.failed_login_attempts) can't stop one IP spraying
// passwords across MANY usernames — each account only sees a few failures.
// This table counts failed FTPS auths per source IP across all usernames within
// a rolling window; crossing the threshold writes an IP-scoped `lockout` row in
// user_bans (see recordFailedLoginByIp). Transient counter only — the ban itself
// is the source of truth for whether an IP is blocked.
// ---------------------------------------------------------------------------
export const ipLoginAttempts = pgTable('ip_login_attempts', {
  sourceIp: inet('source_ip').primaryKey(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
  // Escalation tier — each successive IP lockout lasts longer (mirrors the
  // per-user lockout_count doubling).
  lockoutCount: integer('lockout_count').notNull().default(0),
});

// ---------------------------------------------------------------------------
// login_failures — failed-login counter per (account, channel, source address)
//
// A lockout earned from one address blocks that address only; an attacker's
// guesses cannot lock the owner out from the owner's own. `last_success_at`
// marks a source the account has signed in from before, which the account-wide
// backstop lockout spares. See server/db/queries/lockout.ts.
// ---------------------------------------------------------------------------
export const loginFailures = pgTable(
  'login_failures',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['web', 'ftp'] }).notNull(),
    sourceIp: inet('source_ip').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockoutCount: integer('lockout_count').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.channel, t.sourceIp] }) }),
);

// ---------------------------------------------------------------------------
// user_appeals — DSA Art. 20 appeal log
// ---------------------------------------------------------------------------
export const userAppeals = pgTable(
  'user_appeals',
  {
    id: serial('id').primaryKey(),
    // Text instead of FK: appeal record must survive hard-deleted accounts
    userEmail: text('user_email').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    body: text('body').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    decision: text('decision'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: integer('decided_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    emailIdx: index('idx_user_appeals_email').on(table.userEmail, table.submittedAt.desc()),
  }),
);

// ---------------------------------------------------------------------------
// settings — simple key-value store (jwt_secret, feature flags, etc.)
// ---------------------------------------------------------------------------
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// mcp_audit_log — OAuth lifecycle events plus mutating MCP tool calls
// (delete_video, mute_notifications); read-only tool calls are not audited.
// (user_id/client_id SET NULL on delete so audit rows survive account deletion)
// ---------------------------------------------------------------------------
export const mcpAuditLog = pgTable(
  'mcp_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').references(() => oauthClients.clientId, { onDelete: 'set null' }),
    action: text('action').notNull(),
    detailsJson: jsonb('details_json').$type<Record<string, unknown>>().notNull(),
    // INET column — Postgres network address type
    ip: inet('ip'),
  },
  (table) => ({
    userTsIdx: index('idx_audit_user_ts').on(table.userId, table.ts.desc()),
    actionTsIdx: index('idx_audit_action_ts').on(table.action, table.ts.desc()),
  }),
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type UserBan = typeof userBans.$inferSelect;
export type NewUserBan = typeof userBans.$inferInsert;

export type IpLoginAttempt = typeof ipLoginAttempts.$inferSelect;
export type NewIpLoginAttempt = typeof ipLoginAttempts.$inferInsert;

export type UserAppeal = typeof userAppeals.$inferSelect;
export type NewUserAppeal = typeof userAppeals.$inferInsert;

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

export type McpAuditLog = typeof mcpAuditLog.$inferSelect;
export type NewMcpAuditLog = typeof mcpAuditLog.$inferInsert;
