---
description: Code review checklist for trading-related code
---

Before writing any trading-related code:
- Check for position size calculation errors (always use $ value not token count)
- Verify SL/TP are set immediately after order fills (never leave unprotected)
- Ensure cooldown is set BEFORE order execution to prevent duplicate trades
- Confirm position sync runs every 10 seconds minimum
- Verify PnL is fetched from exchange history (not calculated locally)
- Check error handling - every API call must have try/catch
- Verify all new functions are exported if needed by other agents
