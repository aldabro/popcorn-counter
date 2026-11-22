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
- a **talking filter**, so people chatting in the kitchen don't get counted as pops
- a history of previous batches, stored only in your browser

There's also a **demo** with simulated popcorn, so you can try it without a stove.

Everything runs locally in the browser. Audio is never recorded or uploaded.

## How the detection works

[`js/pop-worklet.js`](js/pop-worklet.js) runs on the audio thread as an AudioWorklet:

1. A 4th-order 1.5 kHz high-pass filter removes hum and rumble from the stove, extractor fan and microwave.
2. Energy is measured in 1.5 ms frames.
3. The background noise level is tracked as the 20th percentile of the last 1.5 s.
4. A sound is a pop candidate when a frame is far enough above the noise level (set by the sensitivity setting) **and** rose sharply compared with the 3–8 ms before it. A 12 ms dead time stops one pop from counting twice.
5. **Talking filter.** Voiced speech is a stream of tiny clicks from the vocal cords (100–250 per second), and each one looks like a small pop. A voice detector tracks pitch (YIN, 70–400 Hz) on the 200–900 Hz band, above the rumble of gas burners and extractor fans. While someone is talking, a candidate only counts if it is bright (its level above 4 kHz is at most 9 dB below its level above 1.5 kHz; voices have little energy up there) and at least 3 dB above the sound right before and after it, or else at least 12 dB above it. Because of this, pops are reported about a quarter of a second late. The filter can be turned off in the settings.

### How well it works

Tested offline with the real detector code in Chrome:

- **Real popcorn:** 16 recordings of stovetop and microwave popcorn from [Freesound](https://freesound.org). With no talking, the talking filter keeps 96% of the pops counted without it.
- **Talking** (real recordings and synthetic voices in English and German), 20 dB above a quiet background: false pops fell from 81 to 18 per minute on average.
- **Talking over gas-burner rumble, extractor fans or kitchen noise:** false pops fell from 157–222 to 21–23 per minute.
- **Real popcorn with non-stop loud talking:** false counts fell from 20% to 11% of the real pops, and about 7% of real pops were lost.
- **Synthetic popcorn:** about 90% of pops caught, with no false positives.

In an end-to-end test, someone talked for 12 seconds before the popcorn started. Without the filter, those false pops looked like a finished batch and set off the stop alarm after 21 seconds. With the filter, the alarm came near the true end of popping.

**Not filtered:** short, sharp kitchen sounds like cutlery, dishes, chopping, running water or sizzling in another pan. They are physically very similar to pops, and often even sharper and brighter. In tests no sound feature could separate them from real pops without also losing many pops. Keep such noise away from the phone while it's popping.

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
