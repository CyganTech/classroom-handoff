# Simple Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** One-command setup and update behind the operator's existing HTTPS proxy.

**Architecture:** A POSIX helper wraps the existing Compose stack without changing its project/volume identity. An optional external proxy network joins the backend; Docker builds only server code.

**Tech Stack:** POSIX sh, Docker Compose v2, Node test runner, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-23-simple-docker-design.md`

## Global Constraints

- Git, Docker Engine and Compose v2 only on the server.
- Never remove volumes or overwrite existing configuration.
- Default to loopback; HTTPS terminates at the existing reverse proxy.
- Preserve the signed extension release unchanged.

## Review Focus

- Existing `.env` must survive repeat setup untouched.
- Malformed origins/options must not create configuration or start containers.
- Dirty/divergent checkouts must not be reset by updates.
- Health/build failures must return failure without a success message.
- Container recreation must preserve authenticated device identity.

### Task 1: Deployment helper and Compose integration

**Files:** `handoff`, `compose.yaml`, `compose.proxy.yaml`, `.env.example`, `tests/deployment.test.ts`.

**Interfaces:** `./handoff setup HTTPS_ORIGIN [--bind IPv4] [--port PORT] [--network NAME]`; `up`, `update`, `status`, `logs`, `stop`, `help`. `.env` supplies Compose configuration; no shell evaluation of it.

- [x] Write CLI tests for configuration, invalid input, repeat setup, directory independence, failed health, safe stop and real Git update/dirty checks.
- [x] Run tests and verify they fail because the helper is missing.
- [x] Implement helper and optional proxy network; add configurable bind address to the original Compose file.
- [x] Run CLI tests and whole test suite; expect green.

### Task 2: Fast build, deployment proof and documentation

**Files:** `Dockerfile`, `scripts/build-server.mjs`, `scripts/build.mjs`, `package.json`, `scripts/docker-smoke.mjs`, `.github/workflows/ci.yml`, `README.md`, `docs/docker-deployment.md`, `docs/verification.md`.

**Interfaces:** `npm run build:server` emits `dist/server/index.js`; `npm run test:docker` exercises the actual helper in its own stack, then removes only that stack.

- [x] Add a failing server-only build check, then implement shared server build and minimal Docker build inputs.
- [x] Exercise real helper setup, rebuild, stop/restart and persistent authenticated access in Docker.
- [x] Document first install, same-host/container/remote proxy choices, updates, health and errors; keep Caddy alternative.
- [x] Run `npm run check`, Docker smoke, all Compose variants and browser E2E. Expect success.
- [x] Commit and publish the completed change after final verification.
- [x] Get a fresh reviewer and address material findings.

## Progress

The operator authorized autonomous implementation in the original requirements. Continue inline using the current project workspace; review the finished change before publishing.

Task 1: complete — CLI tests passed, including real Git clean/dirty/divergent behavior and preserving existing configuration.
Task 2: implementation and verification complete — 64 tests, full build/package, real Docker persistence/proxy network, all Compose configurations and browser E2E passed.
Final review: fixed malformed-origin acceptance; regression RED→GREEN and whole suite passed. No deferred minor findings.
Review scope rulings: actual server DNS/TLS and managed ChromeOS require operator validation; base backend and signed extension are unchanged and existing E2E passed.
