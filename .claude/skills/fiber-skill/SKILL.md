---
name: fiber-skill
description: >
  Developer-focused guide to the Fiber Network project documentation and
  JSON-RPC APIs. Use when Claude needs to help developers understand Fiber's
  architecture, node behavior, payment and cross-chain design, or design and
  debug JSON-RPC calls against a Fiber node. This skill is self-contained with
  all necessary documentation bundled in the references/ directory.
---

# Purpose

Help Claude act as a knowledgeable assistant for the Fiber Network project by
leveraging the official documentation and RPC reference to support developers
who build on, integrate with, or operate Fiber nodes.

Use this skill to:

- Explain Fiber's architecture, protocols, and design goals using the light paper
  and specs.
- Guide developers through using the Fiber node JSON-RPC APIs for channels,
  invoices, payments, peers, graph, watchtower, and profiling.
- Walk through end-to-end workflows such as connecting to peers, opening
  channels, creating invoices, sending payments, and monitoring network state.
- Help debug common issues by mapping symptoms to relevant modules, RPC methods,
  and configuration options.

# Available Knowledge

This skill is self-contained with all documentation bundled in the `references/` directory. Treat the following reference files as the primary knowledge sources:

- High-level papers:
  - `references/light-paper.md` - Overview of Fiber Network architecture and design
  - `references/light-paper-cn.md` - Chinese version of the light paper

- Authentication and security:
  - `references/biscuit-auth.md` - Biscuit authentication and authorization

- Network and node operations:
  - `references/testnet-nodes.md` - Testnet setup and node operations
  - `references/dev-readme.md` - Development documentation

- Notes and operational guides:
  - `references/notes-readme.md` - Overview of operational notes
  - `references/notes-backup-guide.md` - Backup procedures
  - `references/notes-break-change-migrate.md` - Breaking changes and migration guide
  - `references/notes-gossip.md` - Gossip protocol details
  - `references/notes-state-updates.md` - State updates across multiple actors
  - `references/notes-trampoline-routing.md` - Trampoline routing notes (if present)

- Protocol specs:
  - `references/specs-payment-invoice.md` - Payment invoice specification
  - `references/specs-cross-chain-htlc.md` - Cross-chain HTLC specification
  - `references/specs-p2p-message.md` - P2P message specification
  - `references/specs-trampoline-routing.md` - Trampoline routing specification

- RPC reference:
  - `references/rpc-readme.md` - Complete Fiber Network Node (FNN) JSON-RPC API reference
    - Describes all RPC modules, methods, parameters, return types, and RPC types.

When answering, always align with these documents and prefer their definitions over assumptions. Load reference files from the `references/` directory as needed.

# General Usage Guidelines

Follow these principles when using this skill:

- Identify the user's context first:
  - Learning Fiber concepts and architecture.
  - Operating a Fiber node and joining a network.
  - Building payment or cross-chain flows.
  - Integrating via JSON-RPC.
  - Debugging behavior in development or testnet.
- Select the appropriate knowledge source:
  - Use `references/light-paper.md` and spec files for conceptual explanations.
  - Use `references/notes-*.md` and `references/dev-readme.md` for operational and migration guidance.
  - Use `references/rpc-readme.md` for concrete API design, parameters, and types.
  - Use `references/testnet-nodes.md` for environment-specific details and example flows.
- Provide structured, developer-oriented answers:
  - Start with a short summary.
  - Reference the relevant modules or document sections by name.
  - Detail parameters, types, and constraints where needed.
  - Include small, realistic examples (JSON-RPC calls, configuration fragments,
    or data flows).

Clearly call out any features that are experimental, unstable, or marked as
development-only in the docs.

# Fiber JSON-RPC Helper

Use `references/rpc-readme.md` as a precise reference for Fiber JSON-RPC APIs. Organize help
by RPC module.

Main modules:

- Cch
  - Cross-chain hub demonstration, including send_btc, receive_btc, get_cch_order.
- Channel
  - Channel lifecycle: open_channel, accept_channel, abandon_channel,
    list_channels, shutdown_channel, update_channel.
- Dev
  - Development-only RPCs such as commitment_signed, add_tlc, remove_tlc,
    submit_commitment_transaction, check_channel_shutdown.
- Graph
  - Network graph exploration: graph_nodes, graph_channels.
- Info
  - Node metadata and configuration: node_info.
- Invoice
  - Invoice lifecycle: new_invoice, parse_invoice, get_invoice, cancel_invoice,
    settle_invoice.
- Payment
  - Payment flows and routing: send_payment, get_payment, build_router,
    send_payment_with_router.
- Peer
  - Peer connectivity: connect_peer, disconnect_peer, list_peers.
- Prof
  - Profiling: pprof.
- Watchtower
  - Watchtower-related operations: create_watch_channel and other methods.

For each user request involving RPCs:

- Identify the relevant module and method names explicitly.
- Explain method purpose, required preconditions, and typical usage patterns.
- Enumerate key parameters with types and semantics.
- Describe return fields and how to interpret them.
- Provide example JSON-RPC request and response snippets consistent with the
  documented types.

# Data Encoding Requirements

Certain RPC endpoints require numeric fields to be provided as hexadecimal strings rather than raw integers.

This requirement is particularly relevant for parameters that conceptually map to u64 values.

Incorrect example:

{ "limit": 100 }


Correct example:

{ "limit": "0x64" }


Key points:

Numeric parameters such as counts, block numbers, limits, and offsets may need to be encoded as hexadecimal strings.

The agent must convert u64 values to hexadecimal string representations before serializing the JSON payload.

Hexadecimal strings are typically prefixed with "0x".

This behavior is not always explicitly stated in documentation, so careful examination of parameter definitions and examples is recommended.

# Security and Access

Adhere to the security guidance from `references/rpc-readme.md` and other reference docs:

- Treat exposing the JSON-RPC port to arbitrary machines as dangerous and
  strongly discouraged.
- Emphasize that rpc.listening_addr must be restricted to trusted hosts or
  networks.
- Prefer patterns such as:
  - Access over private networks or secure tunnels.
  - Authentication and authorization layers in front of RPC endpoints.
  - Strict separation between development/testnet and production deployments.

When handling keys, preimages, and other secrets:

- Avoid suggesting that users log or persist raw secrets in plain text.
- Recommend secure storage and limited disclosure within trusted components.

# Typical Developer Workflows

Organize assistance around common end-to-end workflows.

## Learn Fiber and Its Protocols

- Use `references/light-paper.md` and spec files to explain:
  - Overall architecture and goals of Fiber.
  - Payment invoice format and lifecycle (see `references/specs-payment-invoice.md`).
  - Cross-chain HTLC mechanisms and related safety properties (see `references/specs-cross-chain-htlc.md`).
  - P2P message types and how they relate to node behavior (see `references/specs-p2p-message.md`).

## Operate a Node and Join a Network

- Use `references/testnet-nodes.md` and `references/dev-readme.md`:
  - Explain how to run a node in testnet or dev setups.
  - Describe configuration options relevant to networking and RPC.
  - Outline basic operational steps and common pitfalls.

## Manage Peers and Channels

- Use Peer and Channel modules:
  - Design sequences like:
    - connect_peer → open_channel → accept_channel.
  - Explain how to inspect and manage channels using list_channels,
    update_channel, shutdown_channel, and abandon_channel.
  - Map channel states and fields from RPC types to real-world scenarios, such
    as liquidity management and routing capacity.

## Handle Invoices and Payments

- Use Invoice + Payment modules (see `references/rpc-readme.md`) and `references/specs-payment-invoice.md`:
  - Show how to create, parse, query, cancel, and settle invoices.
  - Explain payment parameters, including keysend, max_fee_amount, timeout,
    custom_records, and multi-part payments.
  - Guide manual routing scenarios using build_router and send_payment_with_router.

## Cross-Chain and Advanced Flows

- Use Cch module (see `references/rpc-readme.md`) and `references/specs-cross-chain-htlc.md`:
  - Explain the roles of send_btc, receive_btc, and get_cch_order.
  - Clarify how Fiber and external systems (such as Bitcoin or Lightning) are
    coordinated via HTLCs.

- Use Watchtower module:
  - Explain watchtower responsibilities, required keys, and settlement data.
  - Describe how to update revocation and settlement information safely.

## Debugging and Performance

- Use Dev module (development only):
  - Emphasize that these RPCs are not intended for production.
  - Explain how they help simulate or manipulate channel and HTLC state for
    testing.

- Use Prof module:
  - Guide users through collecting CPU profiles and interpreting the resulting
    flamegraph SVG.

# Working with RPC Types

Use the "RPC Types" section of `references/rpc-readme.md` to clarify structures and enums:

- For structs such as Channel, NodeInfo, CkbInvoice, ChannelInfo:
  - Explain each field's semantics, units, and relation to node behavior.
- For enums such as PaymentStatus, CchOrderStatus, ChannelState:
  - Describe each variant and typical state transitions.

When the user asks about a specific field or type:

- Locate the type in `references/rpc-readme.md`.
- Restate its definition in simple, precise language.
- Explain how it appears in RPC responses or is used as a parameter.

# Answering Style

Maintain a developer-friendly answering style:

- Start with a concise summary, then drill into details as needed.
- Use terminology and field names that match the official docs.
- Prefer concrete examples over abstract descriptions when designing workflows
  or RPC calls.
- Highlight unstable or evolving APIs clearly and encourage checking the latest
  project docs and release notes when behavior seems inconsistent.

