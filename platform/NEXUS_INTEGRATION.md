# Nexus platform integration

This directory carries the Harvester platform source imported from `https://github.com/harvester/harvester` on the `master` branch.

- Imported commit: `462ac0ce enhancement: Support Storage Migration for Restored VMs`
- Source root used by Nexus UI helpers: `platform/harvester`
- Nexus-owned UI and workflow code remains at the repository root under `src/`.

The goal is for Nexus to be a branded Harvester-derived system with the platform source available in-tree, not a browser-only add-on layered outside the product.
