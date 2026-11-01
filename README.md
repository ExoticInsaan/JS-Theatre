# JS Theatre

Watch a movie together, in sync. Each person plays their own copy of the video,
so quality is never reduced. Only tiny playback messages (play, pause, seek,
buffering) travel through the server.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, create a room, and send the invite link to your friend.
Both of you choose the same video file from your own computer.

## Starting and staying in sync

- Each person sees a status line: who is missing, who is loading or buffering, and when everyone is in sync.
- Once everyone has chosen the file, press **Start together**. Anyone can press it. Everyone gets a 3-2-1 countdown and the movie starts for all at the same moment.
- Anyone can also play, pause, or seek at any time and everyone follows.
- **Fullscreen** (button or press F) keeps chat and the sync status on top of the video. Press Enter in fullscreen to type a message.

## How it works

- The server keeps one shared clock per room: `playing`, `time`, and who is buffering.
- Play, pause, and seek events are relayed to everyone in the room.
- If anyone's player stalls, everyone waits until they are ready.
- Every 3 seconds the server sends the true position. Small drift is corrected by
  nudging playback speed by 5%, and large drift by seeking.
- Alternatively, paste a direct video link (.mp4/.webm) to load the same hosted video for everyone.

## Playing with a friend over the internet

`localhost` only works on your own machine. To watch with someone elsewhere, deploy
this to any Node host (Render, Railway, Fly.io) or expose your local port with a
tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## Notes

- Use MP4 (H.264/AAC) or WebM for best browser support. MKV often will not play.
- Streaming services (Netflix, Prime, etc.) use DRM and cannot be embedded here.
- Rooms are held in memory and disappear when the last person leaves.
