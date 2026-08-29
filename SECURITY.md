# Security policy

## Supported versions

There is **no supported production version**. `0.x` releases are experimental.

If you discover a vulnerability in any published `0.x` tag, please still report it. We will fix what we can, but we do not promise backports or coordinated disclosure timelines.

## Reporting a vulnerability

**Do not file a public GitHub issue.**

Open a [private GitHub security advisory](https://github.com/misterlib/convex-rn/security/advisories/new) and include:

- A description of the issue
- Steps to reproduce or a proof of concept
- Affected version / commit SHA
- Impact (e.g. cache disclosure, mutation injection, native crash)

Please give a few days before discussing the report in public.

## What this library stores

When Nitro/MMKV is available, query results and the offline mutation queue are written to an on-device MMKV store (`convex-rn-sync-storage`). Treat that as ordinary app data: it is not a secrets vault. Do not put tokens, passwords, or payment details into documents you sync through this cache.
