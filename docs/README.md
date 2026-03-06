# Actual MCP Server Documentation

**Version:** 0.4.8  
**Project:** Model Context Protocol bridge for Actual Budget  
**Last Updated:** 2026-03-06

---

## Documentation Index

This directory is the canonical documentation hub for the active codebase.

### Core Documentation

- **[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)** - product scope, features, tool count, and current project status
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - runtime architecture, transports, session model, and data flow
- **[TESTING_AND_RELIABILITY.md](TESTING_AND_RELIABILITY.md)** - test policy, validation expectations, and CI-relevant guidance
- **[SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)** - auth model, privacy boundaries, and security guidance
- **[ROADMAP.md](ROADMAP.md)** - active forward-looking roadmap only
- **[AI_INTERACTION_GUIDE.md](AI_INTERACTION_GUIDE.md)** - AI-agent workflow and repo modification rules
- **[NEW_TOOL_CHECKLIST.md](NEW_TOOL_CHECKLIST.md)** - required process for adding or modifying MCP tools

### Notes

- The project currently uses a **progressive disclosure** MCP model.
- `tools/list` exposes the gateway tools, while the full internal tool surface is discovered and executed through that layer.
- ✅ Docker short description validated (98/100 characters ✅)

**Project Status**:
- **62 internal tools** implemented behind the MCP gateway model
- **Production-ready** with Docker images on Docker Hub and GHCR
- **Security score**: 100/100 (0 vulnerabilities detected)
- **Code quality score**: 85/100 (Good, consolidated refactoring tracking available)

---

## 🚀 Quick Start

### Installation

```bash
# Clone repository
git clone https://github.com/agigante80/actual-mcp-server.git
cd actual-mcp-server

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Actual Budget server details
```

### Configuration

Required environment variables:

```bash
ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=your_password
ACTUAL_BUDGET_SYNC_ID=your_sync_id
```

See `.env.example` for all configuration options.

### Development

```bash
# Build TypeScript
npm run build

# Run in development mode with debug logging
npm run dev -- --debug --http

# Run tests
npm test

# Lint code
npm run build  # TypeScript compiler performs linting
```

### Production Deployment

```bash
# Using Docker Hub
docker run -d \
  --name actual-mcp-server \
  -p 3600:3600 \
  -e ACTUAL_SERVER_URL=http://your-server:5006 \
  -e ACTUAL_PASSWORD=your_password \
  -e ACTUAL_BUDGET_SYNC_ID=your_sync_id \
  -e MCP_SSE_AUTHORIZATION=$(openssl rand -hex 32) \
  -v actual-mcp-data:/data \
  agigante80/actual-mcp-server:latest
```

See [Architecture](./ARCHITECTURE.md) for detailed deployment options.

---

## 🧪 Testing

### Run All Tests

```bash
# Unit tests
npm run test:unit-js

# Adapter tests
npm run test:adapter

# End-to-end tests
npm run test:e2e
```

### Local Testing Policy

> ⚠️ **CRITICAL**: All tests **must pass locally** before committing or pushing to GitHub.

See [Testing & Reliability](./TESTING_AND_RELIABILITY.md) for detailed testing policies.

---

## 🤖 AI Agent Usage

This project uses AI agents for development and maintenance. If you're an AI agent:

1. **Read [AI Interaction Guide](./AI_INTERACTION_GUIDE.md) first** - Contains mandatory rules
2. **Always run tests locally** before committing
3. **Update affected documentation** after every code change
4. **Follow security policies** in [Security & Privacy](./SECURITY_AND_PRIVACY.md)

---

## 🏗️ Project Structure

```
actual-mcp-server/
├── src/                      # Source code
│   ├── index.ts             # Main entry point
│   ├── config.ts            # Environment validation
│   ├── actualConnection.ts  # Actual Budget API connection
│   ├── actualToolsManager.ts # Tool registry
│   ├── lib/                 # Core libraries
│   ├── server/              # Transport implementations
│   ├── tools/               # MCP tool definitions
│   └── tests/               # Unit tests
├── docs/                    # Documentation (you are here)
├── test/                    # Integration and E2E tests
├── scripts/                 # Build and utility scripts
├── docker-compose.prod.yml  # Production Docker setup
├── Dockerfile               # Container definition
└── package.json             # Dependencies and scripts
```

---

## 🤝 Contributing

### Before Making Changes

1. Read [AI Interaction Guide](./AI_INTERACTION_GUIDE.md) for development policies
2. Review [Project Overview](./PROJECT_OVERVIEW.md) and [Roadmap](./ROADMAP.md) for current scope
3. Review [Security & Privacy](./SECURITY_AND_PRIVACY.md) for security requirements

### Development Workflow

1. Create feature branch: `git checkout -b feature/your-feature`
2. Make changes and update relevant documentation
3. Run full test suite: `npm test && npm run test:adapter`
4. Commit with descriptive message
5. Push and create pull request

### Documentation Sync

When you change code, update these docs:

| Code Change | Update Documentation |
|-------------|---------------------|
| New API route or tool | ARCHITECTURE.md, PROJECT_OVERVIEW.md |
| Test changes | TESTING_AND_RELIABILITY.md |
| Internal refactor or structural cleanup | ARCHITECTURE.md, AI_INTERACTION_GUIDE.md |
| Security/auth changes | SECURITY_AND_PRIVACY.md, AI_INTERACTION_GUIDE.md |
| Environment variable | ARCHITECTURE.md, AI_INTERACTION_GUIDE.md |
| New feature | PROJECT_OVERVIEW.md, ROADMAP.md |

---

## 📊 Project Status

- **Total Internal Tools**: 62
- **MCP-Exposed Tools**: 2 gateway/meta-tools
- **API Coverage**: ~80% of Actual Budget core API
- **Test Coverage**: >80% unit test coverage
- **LibreChat**: ✅ Fully verified and tested
- **Docker Images**: Published to Docker Hub and GHCR
- **CI/CD**: GitHub Actions with automated testing and deployment

See [Roadmap](./ROADMAP.md) for upcoming features.

---

## 🆘 Getting Help

### Documentation

- Start with [Project Overview](./PROJECT_OVERVIEW.md) for high-level understanding
- See [Architecture](./ARCHITECTURE.md) for technical details
- See [Testing & Reliability](./TESTING_AND_RELIABILITY.md) for verification expectations

### Issues

- **Bugs**: Open GitHub issue with steps to reproduce
- **Feature requests**: Check [Roadmap](./ROADMAP.md) first, then open issue
- **Security**: Follow [Security & Privacy](./SECURITY_AND_PRIVACY.md) reporting procedure

---

## 📝 License

MIT License - see LICENSE file for details.

---

## 🔄 Documentation Maintenance

This documentation is maintained by both human developers and AI agents. Every document in `/docs` is automatically updated when relevant code changes occur.

**Last Documentation Audit**: 2026-03-06  
**Next Scheduled Review**: When architecture, tool exposure, or validation policy changes

For documentation maintenance policies, see [AI Interaction Guide](./AI_INTERACTION_GUIDE.md).
