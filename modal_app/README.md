# TxGNN on Modal

Single-file [Modal](https://modal.com) deployment of [TxGNN](https://github.com/mims-harvard/TxGNN), Harvard's drug-repurposing GNN. Loaded with the published `TxGNN_1_complex_disease` checkpoint; serves real predictions over PrimeKG on a T4 GPU.

## Why Modal (and not HF Spaces ZeroGPU)

HF Spaces ZeroGPU requires PyTorch ≥ 2.8 on Blackwell GPUs. DGL (TxGNN's required graph library) has no CUDA wheels published past `torch-2.4/cu124` — its official wheel index simply stops there. On Modal we control the image and pin `torch==2.4.0 + cu124` with `dgl==2.4.0 + cu124`, a combination with known-good wheels.

Other forced pins (TxGNN is 2023-era research code): `pandas==1.5.3` (TxGNN calls `DataFrame.append()` which is removed in pandas 2.0), `numpy<2` (pandas 1.5 is incompatible with numpy 2.x).

## Layout

```
modal_app/
  txgnn_modal.py    # Modal app: image, class, methods, local entrypoint
  verify_mondo.py   # one-shot MONDO id resolution check
  README.md         # this file
```

## Prereqs

- Modal CLI installed and authenticated: `uv tool install modal && modal setup`
- Workspace: `felixglush`

## Run

```bash
# Smoke test (one-off; spins up a container, runs main(), tears down)
modal run modal_app/txgnn_modal.py
modal run modal_app/txgnn_modal.py --search "breast cancer"
modal run modal_app/txgnn_modal.py --disease-id MONDO:0005148

# Deploy as a persistent app (callable via Modal SDK)
modal deploy modal_app/txgnn_modal.py

# Verify MONDO id resolution against the deployed app
uvx --with modal,numpy python modal_app/verify_mondo.py
```

First cold start takes ~5–10 min: image build + PrimeKG download (~1.4 GB from Harvard Dataverse) + heterograph construction. Subsequent cold starts reuse the `txgnn-data` Volume and complete in ~20s.

## Calling from Python

```python
import modal
runner = modal.Cls.from_name("txgnn", "TxGNNRunner")()
runner.predict_disease.remote(disease_id="MONDO:0005148", top_k=10, relation="indication")
# -> {disease_idx, disease_grouped_id, disease_name, relation, predictions: [{drug_id, drug_name, score}, ...]}
```

`disease_id` accepts MONDO ids with or without the `MONDO:` prefix and with or without leading zeros. See the next section for why this needs special handling.

## Disease id resolution

PrimeKG stores disease nodes with `node_id` set to a MONDO numeric (e.g. `"5148"` for type 2 diabetes). For 1,267 of its 17,080 disease nodes (`x_source="MONDO_grouped"`), PrimeKG collapses several semantically-equivalent MONDO terms into a single node and joins their MONDO numerics with `_` — e.g. osteogenesis imperfecta is stored as `"13924_12592_14672_..."`. The grouping logic lives in PrimeKG's `knowledge_graph/build_graph.ipynb`: exact name match plus a BERT cosine ≥ 0.98 pass, with a category blacklist for things like cancers and syndromes that shouldn't merge.

Neither TxGNN nor PrimeKG ships a reverse `MONDO id -> primekg_node` lookup, so the Modal app builds one at startup by splitting each grouped id on `_` and indexing each component.

Two additional storage quirks to be aware of:

- **TxGNN's `convert2str` applies `float()` to non-underscore ids**, so single-MONDO entries are stored as `"5148.0"` (string of a float), while underscore-joined grouped ids are kept verbatim. The resolver routes input through `convert2str` for the same reason.
- **TxGNN reassigns indices** during `prepare_split` — `idx2id_disease[12766]` for type 2 diabetes is unrelated to PrimeKG's `node_index=28208`. Don't mix the two index spaces.

## Inference API

| Method | Signature | Notes |
|---|---|---|
| `health()` | → `{has_weights, num_diseases, num_drugs}` | Sanity check |
| `list_diseases(limit, search)` | → `[{idx, id, name}]` | Optional case-insensitive name search |
| `predict_disease(disease_id, top_k, relation)` | → `{disease_idx, disease_grouped_id, disease_name, relation, predictions: [{drug_id, drug_name, score}]}` | `relation` ∈ `"indication"`, `"contraindication"`, `"off-label"` |

## Cost

T4 GPU at $0.59/hr while a container is warm. `scaledown_window=120` (2 min idle) and Modal's per-second billing keep idle cost at $0. Cold start ~20s with cached Volumes; warm inference ~1.3s.

## Volumes

| Volume | Contents | Source |
|---|---|---|
| `txgnn-data` | PrimeKG: `kg.csv`, `node.csv`, `edges.csv`, plus TxGNN's preprocessed splits | Auto-downloaded by `TxData` from Harvard Dataverse on first cold start |
| `txgnn-checkpoint` | `model.pt`, `config.pkl` | Uploaded manually from `checkpoints_all_seeds.zip` (Zitnik lab Google Drive); we use `TxGNN_1_complex_disease/` |

Re-provisioning the checkpoint Volume:

```bash
# After extracting checkpoints_all_seeds.zip locally
modal volume put txgnn-checkpoint ./TxGNN_1_complex_disease/model.pt /model.pt
modal volume put txgnn-checkpoint ./TxGNN_1_complex_disease/config.pkl /config.pkl
```
