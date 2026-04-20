---
description: Debugging workflow for trading-office issues
---

When debugging issues:
- Always check PM2 logs first: pm2 logs trading-office --lines 50
- Test API calls directly before assuming code is wrong
- Add temporary console.log to trace exact failure point
- Check if issue is in: API response format / async timing / data types / missing env vars
- Always verify fix works by checking logs after pm2 restart
- For position sync issues: always fetch raw Bitget API response first
- Never assume - verify with actual data
