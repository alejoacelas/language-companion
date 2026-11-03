import sys, glob, os
from allosaurus.app import read_recognizer
m = read_recognizer()
for f in sorted(glob.glob(sys.argv[1]+"/*.wav")):
    print(f"{os.path.basename(f):32s} ipa  | {m.recognize(f)}")
    print(f"{os.path.basename(f):32s} deu  | {m.recognize(f, 'deu')}")
