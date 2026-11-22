# 🍿 Popcorn Counter

A browser app that listens to your popcorn through the microphone, counts every pop and tells you when to take it off the heat before it burns.

Enter how many grams of kernels you're popping, put your phone next to the pot or microwave and press **Start listening**. You get:

- the number of pops and the **share of kernels that have popped**
- live stats: pops per second now and at the peak, time of the first pop, time since the last pop
- a **pops-per-second chart** of the whole batch
- an **alarm** (banner, beep and vibration) when it's time to stop. It goes off when the first of these happens:
  - a set share of the kernels has popped (default 85%)
  - after the peak, a gap between pops reaches a set length (default 2.5 s, the classic "2–3 seconds between pops" rule; small batches need a longer gap)
  - an S-curve fitted to the pops so far says about 97% of the batch has popped. This doesn't depend on knowing the kernel count or catching every pop.

  "After the peak" is judged from the S-curve fit over all pops, not from a few seconds of rate data. That way a random cluster among the first sparse pops, or a few false detections, can't set off the alarm early.
- a history of previous batches, stored only in your browser

There's also a **demo** with simulated popcorn, so you can try it without a stove.

Everything runs locally in the browser. Audio is never recorded or uploaded.

## How the detection works

[`js/pop-worklet.js`](js/pop-worklet.js) runs on the audio thread as an AudioWorklet:

1. A 4th-order 1.5 kHz high-pass filter removes hum and rumble from the stove, extractor fan and microwave.
2. Energy is measured in 1.5 ms frames.
3. The background noise level is tracked as the 20th percentile of the last 1.5 s.
4. A pop is counted when a frame is far enough above the noise level (set by the sensitivity setting) **and** rose sharply compared with the 3–8 ms before it. A 12 ms dead time stops one pop from counting twice.

On synthetic test audio with loud background noise and oil-sizzle crackles, it had no false positives and caught about 80% of pops at default sensitivity. The pops it missed were either very quiet or almost on top of another pop.

## Numbers used

- **Kernels per gram:** supplier spec sheets list butterfly popcorn at about 50–74 kernels per 10 g and mushroom popcorn at about 42–62 per 10 g. The app uses **6.5/g** (butterfly) and **5.2/g** (mushroom). You can also enter your own figure.
- **Microwave bags:** the label weight includes fat and salt. The app assumes **70%** of it is kernels.
- **Unpopped kernels:** a [Purdue study](https://www.sciencedaily.com/releases/2005/04/050415112829.htm) of 14 brands found 4–47% left unpopped, so 100% is never reached.

## Running it locally

The microphone and AudioWorklet only work on `https://` or `localhost`, not from a `file://` URL. Serve the folder with any static server:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

There's no build step and there are no dependencies.

## Hosting on GitHub Pages

1. Push this repository to GitHub. GitHub Pages on a free plan needs a public repository.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, then **Save**.
4. After a minute the app is live at `https://<your-user>.github.io/popcorn-counter/`.

GitHub Pages serves over HTTPS, so microphone access works on phones too.
