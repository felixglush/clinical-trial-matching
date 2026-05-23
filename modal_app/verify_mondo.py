"""One-shot check: does MONDO:0005148 (type 2 diabetes) resolve correctly?"""
import modal

runner = modal.Cls.from_name("txgnn", "TxGNNRunner")()
for mid in ["MONDO:0005148", "MONDO:0007254", "0005148", "5148"]:
    r = runner.predict_disease.remote(disease_id=mid, top_k=3, relation="indication")
    if "error" in r:
        print(f"{mid:20} -> ERROR: {r['error']}")
    else:
        print(f"{mid:20} -> idx={r['disease_idx']:>6}  {r['disease_name']}")
        for p in r["predictions"]:
            print(f"  {p['score']:+.3f}  {p['drug_name']}")
