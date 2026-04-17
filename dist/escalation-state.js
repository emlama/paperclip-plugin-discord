// ---------------------------------------------------------------------------
// State helpers — company-aware with backward-compat fallback
// ---------------------------------------------------------------------------
export async function getEscalation(ctx, escalationId, escalationCompanyId) {
    const key = `escalation_${escalationId}`;
    if (escalationCompanyId) {
        const raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
        if (raw)
            return raw;
    }
    // Backward-compat fallback
    const fallback = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    return fallback ?? null;
}
export async function saveEscalation(ctx, record) {
    const scopeId = record.companyId || "default";
    await ctx.state.set({ scopeKind: "company", scopeId, stateKey: `escalation_${record.escalationId}` }, record);
}
export async function trackPendingEscalation(ctx, escalationId, escalationCompanyId = "default") {
    const key = "escalation_pending_ids";
    let raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
    // Backward-compat fallback for reads
    if (!raw && escalationCompanyId !== "default") {
        raw = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    }
    const ids = raw ?? [];
    if (!ids.includes(escalationId)) {
        ids.push(escalationId);
        await ctx.state.set({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key }, ids);
    }
}
export async function untrackPendingEscalation(ctx, escalationId, escalationCompanyId = "default") {
    const key = "escalation_pending_ids";
    let raw = await ctx.state.get({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key });
    // Backward-compat fallback for reads
    if (!raw && escalationCompanyId !== "default") {
        raw = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    }
    const ids = raw ?? [];
    const filtered = ids.filter((id) => id !== escalationId);
    await ctx.state.set({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: key }, filtered);
}
/**
 * Collect pending escalation IDs across both company-scoped and legacy scopes,
 * deduplicating by escalation ID.
 */
export async function collectPendingEscalationIds(ctx, companyId) {
    const scopeIds = companyId && companyId !== "default" ? [companyId, "default"] : ["default"];
    const seenIds = new Set();
    const pendingIds = [];
    for (const sid of scopeIds) {
        const raw = await ctx.state.get({
            scopeKind: "company",
            scopeId: sid,
            stateKey: "escalation_pending_ids",
        });
        for (const id of (raw ?? [])) {
            if (!seenIds.has(id)) {
                seenIds.add(id);
                pendingIds.push(id);
            }
        }
    }
    return pendingIds;
}
//# sourceMappingURL=escalation-state.js.map