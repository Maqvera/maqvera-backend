# Agent Performance Report API

Gap-audit "Gap E" (doc 04 module 21 — "agent performance ranking, revenue-by-agent"). Was blocked on the B2B Agent Portal existing; now unblocked (`AgentModel`/`AgentWalletTransactionModel` are real). A read-only aggregation over already-real data — no new domain concept, no new write path.

## `GET /api/v1/agents/reports/performance?from=&to=&limit=`

Tenant JWT, requires `agent.read` or `agent.manage` (or `admin`). `from`/`to` filter on booking `createdAt`; `limit` caps the returned rows (default 50, max 200) — the response `totals` block always reflects every agent, unaffected by `limit`.

- **Attribution** — a booking is attributed to an agent via `BookingHeaderModel.agentUserId` (the same field `AgentService.getMyBookings` already reads), never a second parallel linkage.
- **Commission earned** — summed from `AgentWalletTransactionModel` rows with `type: "CommissionEarned"` specifically (not every `direction: "Credit"` — a manual `"Adjustment"` credit is real wallet balance but isn't commission the agent earned from a sale, and counting it would overstate performance).
- **Every agent appears**, including one with zero bookings (`bookingCount: 0`, `revenue: 0`) — never silently dropped from the ranking.
- Sorted by `revenue` descending.

Response:
```json
{
  "items": [
    { "agentId": "...", "name": "...", "email": "...", "status": "Active",
      "bookingCount": 12, "revenue": 45000, "commissionEarned": 4500,
      "walletBalance": 4500, "walletCurrency": "USD" }
  ],
  "totals": { "agentCount": 8, "totalBookings": 40, "totalRevenue": 120000, "totalCommissionEarned": 12000 }
}
```

## Related — already covered, no work needed

- **Accounts Receivable/Payable Aging** (same module list, doc 04) — already implemented: `services/FinancialReportService.js`'s `ARAging`/`APAging` cases, via `utils/financeConfig.js`'s `reportTypes`. Not part of this task.
