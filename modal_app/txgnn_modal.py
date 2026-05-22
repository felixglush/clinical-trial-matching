"""TxGNN inference on Modal.

Single-file Modal app that:
  - builds a CUDA image with PyTorch 2.4 + DGL 2.4 + TxGNN-from-git
  - downloads PrimeKG once into a Volume on first cold start
  - exposes predict_disease(mondo_id, top_k, relation) via a class-method endpoint

Deploy:   modal deploy modal_app/txgnn_modal.py
Smoke:    modal run modal_app/txgnn_modal.py
"""

import modal

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------
# DGL has cu124 wheels for torch 2.4. HF Spaces' ZeroGPU requires torch 2.8+
# for which DGL has no wheels — which is why we're on Modal instead of HF.
# Modal lets us pin exact versions and bring our own CUDA base image.

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
        add_python="3.10",
    )
    .apt_install("git", "wget")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "dgl==2.4.0",
        find_links="https://data.dgl.ai/wheels/torch-2.4/cu124/repo.html",
    )
    .pip_install(
        # pandas pinned to last 1.x — TxGNN uses DataFrame.append() (removed in 2.0).
        # numpy pinned <2 because pandas 1.5 isn't compatible with numpy 2.x.
        "numpy==1.26.4",
        "pandas==1.5.3",
        "scikit-learn==1.5.1",
        "tqdm==4.66.5",
        "matplotlib==3.9.2",
        "goatools==1.4.5",
        "requests==2.32.3",
    )
    .pip_install(
        "git+https://github.com/mims-harvard/TxGNN.git@main",
    )
)

# ---------------------------------------------------------------------------
# Volumes
# ---------------------------------------------------------------------------
# PrimeKG (~150MB across three CSVs) is downloaded from Harvard Dataverse on
# first run and cached here for subsequent cold starts.
data_volume = modal.Volume.from_name("txgnn-data", create_if_missing=True)

# Pretrained checkpoint (model.pt + config.pkl) will live here. Phase 1 ships
# without one and uses random weights to verify the stack; Phase 2 loads real
# weights from this volume.
ckpt_volume = modal.Volume.from_name("txgnn-checkpoint", create_if_missing=True)

DATA_DIR = "/data"
CKPT_DIR = "/ckpt"

app = modal.App("txgnn")


@app.cls(
    image=image,
    gpu="T4",
    volumes={DATA_DIR: data_volume, CKPT_DIR: ckpt_volume},
    scaledown_window=60 * 2,
    timeout=60 * 20,
)
class TxGNNRunner:
    @modal.enter()
    def setup(self):
        import os

        from txgnn import TxData, TxGNN

        self.tx_data = TxData(data_folder_path=DATA_DIR)
        # complex_disease + seed=1 matches the published TxGNN_1_complex_disease
        # checkpoint — the data splits must match the split the checkpoint was
        # trained on, otherwise TxEval's "filter known indications" step breaks.
        self.tx_data.prepare_split(split="complex_disease", seed=1)

        self.tx_gnn = TxGNN(
            data=self.tx_data,
            weight_bias_track=False,
            proj_name="TxGNN",
            exp_name="TxGNN",
            device="cuda:0",
        )

        ckpt_path = os.path.join(CKPT_DIR, "model.pt")
        cfg_path = os.path.join(CKPT_DIR, "config.pkl")
        if os.path.exists(ckpt_path) and os.path.exists(cfg_path):
            print(f"Loading pretrained checkpoint from {CKPT_DIR}")
            self.tx_gnn.load_pretrained(CKPT_DIR)
            self.has_weights = True
        else:
            print("No pretrained checkpoint found — initializing untrained model")
            self.tx_gnn.model_initialize(
                n_hid=100,
                n_inp=100,
                n_out=100,
                proto=True,
                proto_num=3,
                attention=False,
                sim_measure="all_nodes_profile",
                agg_measure="rarity",
                num_walks=200,
                path_length=2,
            )
            self.has_weights = False

        self.id_mapping = self.tx_data.retrieve_id_mapping()
        # PrimeKG collapses related disease ontology terms into a single node,
        # so idx2id_disease values look like "13924_12592_14672_..." (underscore-
        # joined MONDO numerics, no prefix). Build two reverse indexes:
        #  - exact: full grouped-id -> idx
        #  - component: each MONDO numeric -> idx (so callers can look up by
        #    a single MONDO id without knowing the grouping)
        self._id2idx_disease_exact = {
            str(v): int(k) for k, v in self.id_mapping["idx2id_disease"].items()
        }
        self._mondo_component_to_idx: dict[str, int] = {}
        for grouped_id, idx in self._id2idx_disease_exact.items():
            for component in grouped_id.split("_"):
                # Don't overwrite — first disease node wins on conflict.
                self._mondo_component_to_idx.setdefault(component, idx)

    @modal.method()
    def health(self) -> dict:
        return {
            "has_weights": self.has_weights,
            "num_diseases": len(self._id2idx_disease_exact),
            "num_drugs": len(self.id_mapping["idx2id_drug"]),
        }

    def _resolve_disease_idx(self, disease_id: str) -> int | None:
        """Resolve a disease identifier to PrimeKG node idx.

        Accepts:
          - MONDO:0005148  -> strips prefix, matches MONDO numeric component
          - 0005148        -> matches MONDO numeric component
          - 5148           -> matches MONDO numeric component (lossy, but PrimeKG
                              stores ids without leading zeros)
          - underscore-joined grouped id -> exact match
        """
        if disease_id in self._id2idx_disease_exact:
            return self._id2idx_disease_exact[disease_id]
        stripped = disease_id.split(":", 1)[-1].lstrip("0") or "0"
        if stripped in self._mondo_component_to_idx:
            return self._mondo_component_to_idx[stripped]
        return None

    @modal.method()
    def list_diseases(self, limit: int = 50, search: str | None = None) -> list[dict]:
        idx2id = self.id_mapping["idx2id_disease"]
        id2name = self.id_mapping["id2name_disease"]
        out = []
        for idx, mid in idx2id.items():
            mid_s = str(mid)
            name = id2name.get(mid_s, "<unknown>")
            if search and search.lower() not in name.lower() and search.lower() not in mid_s.lower():
                continue
            out.append({"idx": int(idx), "id": mid_s, "name": name})
            if len(out) >= limit:
                break
        return out

    @modal.method()
    def predict_disease(
        self,
        disease_id: str,
        top_k: int = 20,
        relation: str = "indication",
    ) -> dict:
        """Top-K drug predictions for a disease.

        disease_id: MONDO id (with or without prefix) or PrimeKG grouped id.
        relation: "indication", "contraindication", or "off-label"
        """
        from txgnn import TxEval

        if relation not in {"indication", "contraindication", "off-label"}:
            return {"error": f"invalid relation: {relation}"}

        disease_idx = self._resolve_disease_idx(disease_id)
        if disease_idx is None:
            return {
                "error": f"unknown disease id: {disease_id}",
                "hint": "send a MONDO id (e.g. 'MONDO:0005148') or use list_diseases()",
            }

        evaluator = TxEval(model=self.tx_gnn)
        raw = evaluator.eval_disease_centric(
            disease_idxs=[disease_idx],
            relation=relation,
            return_raw=True,
            verbose=False,
        )

        # TxEval returns { prediction: {disease_id: {drug_db_id: score}}, ... }.
        # We pull the prediction dict for our one disease, sort by score desc,
        # take top_k, and resolve drug names.
        grouped_id = next(iter(raw["prediction"].keys()))
        scores = raw["prediction"][grouped_id]
        id2name_drug = self.id_mapping["id2name_drug"]

        ranked = sorted(scores.items(), key=lambda kv: float(kv[1]), reverse=True)[:top_k]
        predictions = [
            {
                "drug_id": str(db_id),
                "drug_name": id2name_drug.get(str(db_id), "<unknown>"),
                "score": float(score),
            }
            for db_id, score in ranked
        ]

        return {
            "disease_idx": disease_idx,
            "disease_grouped_id": grouped_id,
            "disease_name": self.id_mapping["id2name_disease"].get(grouped_id),
            "relation": relation,
            "has_weights": self.has_weights,
            "predictions": predictions,
        }


@app.local_entrypoint()
def main(disease_id: str = "", search: str = ""):
    """Smoke test. Run with:
      modal run modal_app/txgnn_modal.py
      modal run modal_app/txgnn_modal.py --search diabetes
      modal run modal_app/txgnn_modal.py --disease-id MONDO:0005148
    """
    runner = TxGNNRunner()
    print("Health:", runner.health.remote())

    sample = runner.list_diseases.remote(limit=5, search=search or None)
    print(f"\nSample diseases (search={search!r}):")
    for d in sample:
        print(f"  idx={d['idx']:>6}  {d['name']}")

    target = disease_id or (sample[0]["id"] if sample else None)
    if not target:
        print("\nNo target disease found.")
        return
    print(f"\nPredicting indications for: {target}")
    result = runner.predict_disease.remote(
        disease_id=target, top_k=10, relation="indication"
    )
    if "error" in result:
        print("ERROR:", result)
        return
    print(f"Disease: {result['disease_name']} (idx {result['disease_idx']})")
    print(f"Top {len(result['predictions'])} indications:")
    for p in result["predictions"]:
        print(f"  {p['score']:+.3f}  {p['drug_id']:<10}  {p['drug_name']}")
