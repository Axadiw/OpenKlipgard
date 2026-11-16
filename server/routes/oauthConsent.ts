import { Router, type NextFunction, type Request, type Response } from 'express';
import { getConsentTxn } from '../db/queries/oauth.js';
import { CONFIG } from '../config.js';
import { getUserByInternalId } from '../db/queries/users.js';
import { signInRefusal } from '../hooks.js';
import { requireOwner } from '../middleware/editionGuards.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:txn', async (req: Request, res) => {
  // txn_id is UUID-typed in Postgres — feeding it a non-UUID string throws
  // `22P02 invalid input syntax for type uuid` and bubbles to a 500. Treat
  // malformed input as just-another-unknown-txn so consumers see a single
  // 404 shape regardless of input format.
  const txn = String(req.params.txn);
  if (!UUID_RE.test(txn)) {
    return res.status(404).json({ error: 'txn_not_found_or_expired' });
  }
  const row = await getConsentTxn(txn);
  if (!row) return res.status(404).json({ error: 'txn_not_found_or_expired' });
  res.json({
    clientName: row.clientName,
    scopes: row.scope.split(/\s+/).filter(Boolean),
    redirectUri: row.redirectUri,
  });
});

// [MCP-219] An approval gives an AI assistant access to the account's
// recordings, so it passes the edition's content-owner gate: on Klipgard Cloud
// an administrator (no recordings of its own) cannot approve. A denial gives
// nothing away and stays open. Self-hosted installs have no such gate.
function ownerGateOnApprove(req: Request, res: Response, next: NextFunction): void {
  if ((req.body as { decision?: unknown } | undefined)?.decision === 'approve') {
    requireOwner(req, res, next);
    return;
  }
  next();
}

router.post('/:txn', ownerGateOnApprove, async (req: Request, res) => {
  const userId = (req as any).user?.userId;
  if (typeof userId !== 'number') return res.status(401).json({ error: 'unauthorized' });
  const { decision, scopes } = (req.body ?? {}) as { decision?: string; scopes?: string[] };
  if (decision !== 'approve' && decision !== 'deny') {
    return res.status(400).json({ error: 'invalid_decision' });
  }
  // An MCP grant is a way in of its own: the edition's sign-in rule applies to
  // approving one (a session that predates the rule must not mint a grant).
  if (decision === 'approve') {
    const owner = await getUserByInternalId(userId);
    // A deactivated account (a sanction) mints no grant, whatever session it still holds.
    if (owner && owner.active === false) return res.status(403).json({ error: 'Account unavailable' });
    const refusal = owner ? signInRefusal(owner) : null;
    if (refusal) return res.status(refusal.status).json(refusal.body);
  }
  const body = decision === 'approve'
    ? { txn: req.params.txn, userId, decision, grantedScopes: (scopes ?? []).join(' ') }
    : { txn: req.params.txn, userId, decision };
  const mcpRes = await fetch(`${CONFIG.internalMcpUrl}/mcp/oauth/internal/consent-callback`, {
    method: 'POST',
    // [ARCH-017] `X-Internal-Key` is the shared name. The old
    // `X-Internal-Api-Key` rides along until every mcp pod reads the new one.
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': CONFIG.internalApiKey,
      'X-Internal-Api-Key': CONFIG.internalApiKey,
    },
    body: JSON.stringify(body),
  });
  if (!mcpRes.ok) return res.status(502).json({ error: 'mcp_callback_failed' });
  const data = (await mcpRes.json()) as { redirect_url: string };
  res.json({ redirectUrl: data.redirect_url });
});

export default router;
