import sys, glob, os, time, numpy as np, torch, soundfile as sf, onnxruntime as ort
from huggingface_hub import hf_hub_download
from lhotse.features.kaldi.extractors import Fbank, FbankConfig
repo = sys.argv[1]; audio_dir = sys.argv[2]
onnx = hf_hub_download(repo, "model.onnx"); tok = hf_hub_download(repo, "tokens.txt")
vocab = {}
for line in open(tok, encoding="utf-8"):
    p = line.strip().split()
    if p: vocab[int(p[1]) if len(p)>1 else len(vocab)] = p[0]
ext = Fbank(FbankConfig(num_filters=80, dither=0.0, snip_edges=False))
sess = ort.InferenceSession(onnx)
for f in sorted(glob.glob(audio_dir+"/*.wav")):
    a, sr = sf.read(f)
    t = time.time()
    feat = ext.extract_batch([torch.from_numpy(a).float()], sampling_rate=16000)[0].unsqueeze(0).numpy()
    lp = sess.run(None, {"x": feat, "x_lens": np.array([feat.shape[1]], dtype=np.int64)})[0][0]
    ids = lp.argmax(-1); out=[]; prev=-1
    for i in ids:
        if i != 0 and i != prev: out.append(vocab.get(int(i), "?"))
        prev = i
    print(f"{os.path.basename(f):32s} {time.time()-t:4.2f}s | {' '.join(out)}")
