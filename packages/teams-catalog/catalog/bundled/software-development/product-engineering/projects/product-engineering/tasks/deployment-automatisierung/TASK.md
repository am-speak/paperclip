---
name: Deployment-Automatisierung
slug: deployment-automatisierung
assignee: cto
project: product-engineering
recurring: true
---

Run `node scripts/deployment-gate.mjs --target=ci --verbose` to validate pre-deploy infrastructure health: quality gates, staging health, SSL certificates, CSP compliance, production health, deployment lock status, and cache readiness. If any gate fails, create a critical blocked issue. If all pass, confirm deployment readiness.

