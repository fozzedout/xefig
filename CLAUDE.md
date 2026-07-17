# Ship sequence

Deploy first, then review, then commit and push — in that order.

- **Deploy**: `npm run deploy` from repo root (uses wrangler.toml)
- **Review**: production visuals cannot be checked locally; deploy so they can be seen
- **Commit + push**: only once the change is confirmed final

Committing is not deploying. Do not commit before deploying.
