# E10 — AI-ready API: REST + MCP (BE, TDD)

Основание: `docs/architecture/PLAN-dorabotka.md` §A3.

## T-1001 · REST для агентов
- `GET /api/projects/:id/requirements?format=openspec` — склеенный OpenSpec-текст проекта.
- Набросок контрактов в `docs/architecture/api.md` (пути, входы/выходы, коды ошибок).
- **Приёмка:** тест на формат ответа; ошибки маппятся в коды.

## T-1002 · MCP-сервер `apps/mcp` (`@po/mcp`)
- Новый workspace, `@modelcontextprotocol/sdk`, stdio-транспорт. Обёртка над сервисами
  `@po/core`/`@po/server` (без HTTP), общая `PROJECTS_ROOT`.
- Tools: `list_projects, get_project, list_requirements, get_requirement,
  create_requirement, update_requirement, link_requirements, delete_requirement,
  export_project`.
- Входы валидируются zod-схемами из `@po/core`.
- **Приёмка (unit, S31–S34):** регистрация tools; доменные ошибки → MCP error; read-tools
  без сайд-эффектов; smoke `list_requirements` на временной директории.

## DoD
- Тесты зелёные; `typecheck`/`lint` OK; MCP запускается по stdio (`node apps/mcp/dist/main.js`).
- README: короткая секция «как подключить MCP» (в Фазе E3).
