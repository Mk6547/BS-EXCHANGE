"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertWithinMaxBet = assertWithinMaxBet;
/**
 * Enforce a player's per-category max bet at placement time.
 *
 * The limit lives on users.max_bets (JSON keyed by category), set by the
 * player's admin under the master's ceiling. This helper is a plain function so
 * the game services can call it with the DataSource they already hold — no new
 * injection, no circular imports.
 *
 * A missing or zero limit means "no cap from the hierarchy"; the game's own
 * min/max still applies on top.
 */
async function assertWithinMaxBet(ds, userId, category, stake) {
    const rows = await ds.query(`SELECT max_bets FROM users WHERE id = ?`, [userId]).catch(() => []);
    const raw = rows?.[0]?.max_bets;
    if (!raw)
        return;
    let map = {};
    try {
        map = typeof raw === 'object' ? raw : JSON.parse(raw);
    }
    catch {
        return;
    }
    const cap = Number(map?.[category] ?? 0);
    if (cap > 0 && stake > cap) {
        throw new Error(`Your maximum bet for this is ${cap.toLocaleString('en-PK')}.`);
    }
}
