# TxGNN on Modal

Single-file Modal deployment of [TxGNN](https://github.com/mims-harvard/TxGNN), Harvard's drug-repurposing GNN.

## Why Modal (and not HF Spaces ZeroGPU)

ZeroGPU requires PyTorch ≥ 2.8 on Blackwell GPUs. DGL (TxGNN's required graph library) has no CUDA wheels published for torch 2.8+ — the latest official wheel index stops at `torch-2.4/cu124`. On Modal we control the image, so we pin `torch==2.4.0 + cu124` and `dgl==2.4.0 + cu124`, a combination with known-good wheels.

## Layout

```
modal_app/
  txgnn_modal.py    # Modal app: image, class, methods, local entrypoint
  README.md         # this file
```

## Prereqs

- Modal CLI installed and authenticated: `uv tool install modal && modal setup`
- Workspace: `felixglush`

## Run

```bash
# Smoke test (one-off; spins up a container, runs main(), tears down)
modal run modal_app/txgnn_modal.py

# Deploy as a persistent app (callable via Modal SDK / web endpoint)
modal deploy modal_app/txgnn_modal.py
```

First cold start takes ~5–10 min: image build + PrimeKG download (~150MB from Harvard Dataverse) + heterograph construction. Subsequent cold starts reuse the `txgnn-data` Volume and complete in ~30s.

## Phase 1 (current) vs Phase 2

- **Phase 1**: ships without a pretrained checkpoint. Model uses random init weights — predictions are **not real**. Goal is to verify the torch+DGL+TxGNN stack runs end-to-end on Modal GPUs.
- **Phase 2**: load the published checkpoint into the `txgnn-checkpoint` Volume. Setup auto-detects and switches to `load_pretrained()`.

To upload the checkpoint to the Volume:

```bash
# After downloading model.pt + config.pkl locally (from the Google Drive link
# in the TxGNN README: 1fxTFkjo2jvmz9k6vesDbCeucQjGRojLj)
modal volume put txgnn-checkpoint ./model.pt /model.pt
modal volume put txgnn-checkpoint ./config.pkl /config.pkl
```

## Cost

T4 GPU is $0.59/hr while running. The class scales down 5 min after the last call (`scaledown_window=300`). Modal bills per-second of container runtime — idle = $0.
