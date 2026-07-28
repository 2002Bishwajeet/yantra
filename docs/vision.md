# Yantra — Scope & Vision

> Archived from the original scope document (project was codenamed **NEXUS**).
> Name is now **Yantra (यन्त्र)**. Kept otherwise unedited — this defines the *destination*.
> For what is actually being built right now, see [../tracker.md](../tracker.md).

### Personal Developer Control Plane

> One interface to control every development environment, AI coding agent, and workspace across all my machines.

---

# Vision

Yantra is a hardware-backed developer control plane.

Instead of managing individual computers, terminals, SSH sessions, and AI agents manually, I want a single system that understands my **workspaces** and orchestrates everything for me.

The hardware appliance acts as the central brain.

Every device (Mac, Windows, Linux, iPhone, iPad, Browser, CLI) becomes a client.

---

# Problem Statement

Today my workflow looks like:

- Which machine was I using?
- Which tmux session?
- Is Codex already running?
- Which repository is checked out?
- Is my Mac awake?
- Is Windows currently busy?
- Did I leave something running?

I don't want to think about infrastructure.

I want to think about projects.

---

# Core Philosophy

## Existing software already solves:

- SSH
- Docker
- Networking
- Tailscale
- Monitoring
- Notifications

Don't rebuild them.

Integrate them.

---

## Build only the missing layer.

The missing layer is:

**Developer orchestration.**

---

# The Main Idea

Current workflow:

```
User → Choose machine → SSH → tmux → Repository → Agent
```

Desired workflow:

```
User → Open Workspace → Yantra → Chooses machine (or lets me choose)
     → SSH → Restore session → Launch agent → Ready to code
```

---

# First-Class Objects

Everything revolves around these concepts.

---

## Machines

Every physical computer.

Properties

- hostname
- operating system
- CPU
- RAM
- GPU
- online/offline
- battery
- tags
- available resources

---

## Workspaces

A workspace is NOT a repository.

A workspace is:

> Everything required to continue development.

Contains

- repository
- branch
- startup commands
- preferred OS
- preferred machines
- environment variables
- tmux session
- AI agent
- secrets reference
- Docker containers (future)

---

## Sessions

A running instance of a workspace.

Tracks

- started time
- machine
- logs
- agent
- status
- terminal
- notifications

---

## Scheduler

The scheduler decides where sessions run.

Three modes:

### Manual

User selects — Mac / Windows / Linux. Launch there.

### Preferred

Workspace says: Prefer macOS. Fallback: Linux.

### Automatic

The scheduler chooses based on availability, CPU, RAM, GPU, battery, current load, user preferences.

---

# Hardware

The hardware is the heart of the project.

It should become a premium developer appliance.

Possible platforms:

- Raspberry Pi 5
- Orange Pi 5
- Intel N100 Mini PC

Future:

- custom PCB
- custom enclosure
- custom electronics

Built in the university workshop.

---

# Hardware Features

Display — OLED, IPS, Touchscreen, E-Ink status display

Controls — rotary encoder, programmable buttons, mechanical switches

Connectivity — NFC, Ethernet, USB-C, GPIO

Indicators — RGB LEDs, status lights

Future — fingerprint reader, sensors, Bluetooth, Zigbee, LoRa

---

# UI

Everything should be configurable from the UI.

No manual YAML editing.

Example: Create Workspace → Repository → Preferred Machine → Preferred OS → Preferred Agent → Notifications → Startup Commands → Save. Done.

Internally, configurations may be stored as YAML or JSON.

---

# AI Agent Management

Support: Codex, Claude Code, Gemini CLI, Aider, OpenCode, future agents

Operations: launch, stop, resume, restart, logs

---

# Existing Software to Integrate

| Area | Tools |
| --- | --- |
| Networking | Tailscale |
| Terminal | tmux, zellij |
| Containers | Docker, Dockge, Portainer |
| Monitoring | Uptime Kuma, Glances |
| Notifications | ntfy, Gotify |
| Dashboard inspiration | Homepage, Homarr |
| Authentication | Tailscale auth, OAuth (future) |

---

# Research Tasks

Research every project before writing code.

**Infrastructure** — Tailscale, Headscale. *How do they expose machine information?*

**Workspaces** — DevPod, GitHub Codespaces, VS Code Remote SSH, JetBrains Gateway. *How do they model workspaces?*

**AI** — Codex, Claude Code, Gemini CLI. *How are sessions restored? Can they be automated?*

**Scheduling** — Nomad, Kubernetes, Docker Swarm. Not to use them directly. Study how they schedule workloads.

---

# MVP Roadmap

| Phase | Deliverable |
| --- | --- |
| 1 | Machine discovery |
| 2 | Remote SSH launcher |
| 3 | Workspace model |
| 4 | Web UI |
| 5 | AI orchestration |
| 6 | Scheduler |
| 7 | Hardware prototype |
| 8 | Custom enclosure |
| 9 | Custom PCB |

---

# Stretch Goals

Wake-on-LAN · NAS integration · GitHub integration · MCP server management · Local LLM management · CI runners · Voice commands · Plugin ecosystem · Mobile application · Home Assistant integration

---

# Guiding Principles

- Workspace-first
- API-first
- UI-first
- Local-first
- Plugin architecture
- Existing OSS over reinvention
- SSH as transport
- Tailscale as network
- tmux for persistence

---

# Questions to Answer During Research

- What already exists?
- What should be reused?
- What should become plugins?
- What is Yantra uniquely responsible for?
- Why would another developer use this?

---

# Project Identity

Yantra is **not**:

- another homelab dashboard
- another Raspberry Pi project
- another SSH wrapper
- another Docker UI

Yantra **is**:

A developer control plane that orchestrates workspaces, AI coding sessions, and machines through one unified interface.

---

# Long-Term Vision

Imagine opening your phone and pressing:

> Continue "Yantra"

Within seconds:

- the correct machine wakes up
- the repository is opened
- tmux is restored
- the agent resumes
- notifications are configured
- logs are available
- browser opens automatically

You never think about *where* you're working.

You only think about **what** you're building.

---

# Final Mission Statement

Build a beautiful hardware appliance and software platform that becomes the central nervous system of my development workflow.

One workspace. One interface. Every machine. Anywhere.
