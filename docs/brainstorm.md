# Yantra — Brainstorm & Vision

> Archived verbatim from the original brainstorm (project was codenamed **NEXUS** at the
> time of writing). The name is now **Yantra (यन्त्र)** — see [adr/0002-project-name.md](adr/0002-project-name.md).
> Kept unedited on purpose: this is the founding intent document, not a spec.

---

# The Idea

Build a **personal developer operating system** centered around a dedicated hardware hub.

The goal is not to manage computers.

The goal is to manage **development work**.

Instead of remembering which machine is running what, Yantra knows.

Instead of connecting to machines, I connect to my workspaces.

---

# Why

Modern development is becoming fragmented.

I own multiple computers.

- MacBook
- Windows laptop
- Linux workstation
- iPad
- iPhone

Soon I will also have multiple AI coding agents.

- Codex
- Claude Code
- Gemini CLI
- OpenCode
- Future agents

Managing all of these individually quickly becomes overwhelming.

Yantra exists to remove that complexity.

---

# The Mental Model

Today I think about machines.

Tomorrow I should think about projects.

Instead of asking:

> Which computer has my project?

I should ask:

> Continue Project X.

Yantra handles everything else.

---

# Core Principle

Everything is a Workspace.

Not machines.

Not repositories.

Not terminals.

Workspaces.

A workspace represents everything required to continue working.

---

# What is a Workspace?

A workspace contains things like

- repository
- branch
- preferred operating system
- preferred machine
- AI coding agent
- tmux session
- startup commands
- Docker services
- environment variables
- notifications

Opening a workspace restores context.

Not just files.

---

# The Hardware

The hardware is not a Raspberry Pi project.

The hardware is the physical identity of Yantra.

It should feel like a premium developer appliance.

Think:

- always-on
- quiet
- beautiful
- useful
- modular
- repairable
- enjoyable to use

The hardware exists because interacting with physical controls is satisfying.

---

# Hardware Vision

Initially

- Raspberry Pi 5
- Orange Pi
- Intel N100 Mini PC

Eventually

- custom enclosure
- custom PCB
- custom front panel
- custom electronics

Designed and built in the university workshop.

---

# Hardware Features

Displays

- OLED
- IPS
- E-Ink
- Touchscreen

Controls

- Rotary encoder
- Mechanical switches
- Programmable buttons

Feedback

- RGB LEDs
- Status lights
- Tiny speaker

Connectivity

- NFC
- USB-C
- Ethernet
- GPIO

Future ideas

- Fingerprint reader
- Zigbee
- Bluetooth
- Environmental sensors

---

# The Control Plane

Everything talks to Yantra.

Phone

↓

Browser

↓

CLI

↓

Hardware

↓

API

↓

Scheduler

↓

Machines

No client talks directly to another machine.

Everything goes through the control plane.

---

# Scheduling Philosophy

Scheduling should assist.

Not dictate.

Three modes

## Manual

I explicitly choose

Mac

Windows

Linux

Run there.

---

## Preferred

Workspace says

Prefer macOS.

If unavailable

Ask me.

---

## Automatic

Yantra chooses based on

- available RAM
- CPU load
- GPU
- battery
- online status
- preferences
- previous session

---

# User Experience

Current workflow

Remember machine

↓

SSH

↓

Find repository

↓

Restore tmux

↓

Launch agent

↓

Start coding

Desired workflow

Open Workspace

↓

Yantra handles everything

↓

Coding resumes

---

# Existing Software

This project should integrate existing software rather than replacing it.

Networking

- Tailscale

SSH

- OpenSSH

Terminal

- tmux
- zellij

Containers

- Docker
- Dockge
- Portainer

Monitoring

- Uptime Kuma

Notifications

- ntfy

Dashboards

- Homepage
- Homarr

These are building blocks.

Not competitors.

---

# What Yantra Actually Builds

Yantra should not replace SSH.

It should orchestrate SSH.

Yantra should not replace Docker.

It should orchestrate Docker.

Yantra should not replace tmux.

It should orchestrate tmux.

The value is orchestration.

Not reinvention.

---

# AI Integration

Supported agents

- Codex
- Claude Code
- Gemini CLI
- Aider
- OpenCode

Future agents should be plugins.

Every agent should behave identically from the user's perspective.

Launch.

Resume.

Stop.

View logs.

Done.

---

# UI Philosophy

Everything should be configurable from the interface.

No YAML editing.

No configuration files.

Configuration files are implementation details.

The interface should generate them automatically.

---

# Architecture Principles

Workspace-first

API-first

Plugin-first

Local-first

Hardware-first

Offline-friendly

Everything over Tailscale

SSH for execution

tmux for persistence

---

# Things to Research

Infrastructure

- Tailscale
- Headscale

Workspace tools

- DevPod
- GitHub Codespaces
- JetBrains Gateway
- VS Code Remote SSH

Scheduling

- Nomad
- Kubernetes
- Docker Swarm

Agent frameworks

- Codex
- Claude Code
- Gemini CLI

Terminal management

- tmux
- zellij

The question is always

"What can I reuse?"

---

# MVP

Phase 1

Machine discovery

↓

Phase 2

SSH launcher

↓

Phase 3

Workspace model

↓

Phase 4

Web UI

↓

Phase 5

AI orchestration

↓

Phase 6

Scheduling

↓

Phase 7

Hardware prototype

↓

Phase 8

Custom enclosure

↓

Phase 9

Custom PCB

---

# Future Possibilities

Wake-on-LAN

GPU scheduling

Local LLM orchestration

NAS integration

CI runner management

GitHub integration

Home Assistant

Plugin marketplace

Voice control

Multi-user support

Mobile application

Developer analytics

---

# Guiding Questions

Before building anything, ask:

Does this already exist?

Can I integrate instead of rebuild?

Does this make the developer experience simpler?

Is this solving my workflow or creating more complexity?

---

# What Makes Yantra Different?

Most tools are machine-centric.

Yantra is workspace-centric.

Most tools manage infrastructure.

Yantra manages developer context.

Most tools ask:

"Where do you want to connect?"

Yantra asks:

"What do you want to continue building?"

That is the abstraction.

---

# Mission Statement

Build a beautiful hardware appliance and software platform that becomes the central nervous system of my development workflow.

One workspace.

One interface.

Every machine.

Every AI agent.

Accessible anywhere through my private Tailscale mesh.

The goal is to eliminate friction so completely that I never think about infrastructure again.

I simply continue building.
