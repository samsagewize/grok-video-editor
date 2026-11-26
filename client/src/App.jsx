import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { formatTime } from "./time.js";

const SPEECH =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export default function App() {
  const [project, setProject] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selectedClipId, setSelectedClipId] = useState(null);
  const [view, setView] = useState("program"); // program | clip
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported] = useState(Boolean(SPEECH));
  const [dropActive, setDropActive] = useState(false);
  const [timelineDrop, setTimelineDrop] = useState(false);

  const videoRef = useRef(null);
  const fileRef = useRef(null);
  const chatEndRef = useRef(null);
  const recognitionRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  const clipsById = useMemo(() => {
    const map = new Map();
    (project?.clips || []).forEach((c) => map.set(c.id, c));
    return map;
  }, [project]);

  const currentVersion = useMemo(
    () => project?.versions?.find((v) => v.id === project.currentVersionId) || null,
    [project]
  );

  const selectedClip = selectedClipId ? clipsById.get(selectedClipId) : null;

  const preview = useMemo(() => {
    if (view === "clip" && selectedClip) {
      return { url: selectedClip.url, duration: selectedClip.duration, label: selectedClip.name, kind: "clip" };
    }
    if (currentVersion) {
      return {
        url: currentVersion.url,
        duration: currentVersion.duration,
        label: currentVersion.label,
        kind: currentVersion.kind === "audio" ? "audio" : "program",
      };
    }
    if (selectedClip) {
      return { url: selectedClip.url, duration: selectedClip.duration, label: selectedClip.name, kind: "clip" };
    }
    const first = project?.timeline?.[0] ? clipsById.get(project.timeline[0]) : null;
    if (first) return { url: first.url, duration: first.duration, label: first.name, kind: "clip" };
    return null;
  }, [view, selectedClip, currentVersion, project, clipsById]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.health(), api.project()])
      .then(([h, p]) => {
        if (cancelled) return;
        setHealth(h);
        setProject(p.project);
        setMessages([
          {
            role: "assistant",
            content: h.mockMode
              ? "I'm in mock mode (no xAI key yet), but I can still run edits. Drop a video on the stage or the clip list, then tell me what to change — or tap an action."
              : "Drop a video on the stage or the clip list, then tell me what to change. I can trim, cut, split, merge, speed, caption, fade, crop, and more.",
          },
        ]);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    setCurrentTime(0);
    setPlaying(false);
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  }, [preview?.url]);

  const playhead = videoRef.current?.currentTime ?? currentTime;

  const onFiles = useCallback(async (fileList) => {
    const files = [...(fileList || [])].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
    if (!files.length) {
      setError("Drop a video file (mp4, mov, webm, or mkv).");
      return;
    }
    setError("");
    setBusy("Uploading…");
    try {
      const data = await api.upload(files);
      setProject(data.project);
      if (data.added?.[0]) {
        setSelectedClipId(data.added[0]);
        if (!data.project.currentVersionId) setView("clip");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }, []);

  const onStageDrop = (event) => {
    event.preventDefault();
    setDropActive(false);
    if (event.dataTransfer.files?.length) onFiles(event.dataTransfer.files);
  };

  const sendChat = async (text) => {
    const content = String(text || "").trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user", content }];
    setMessages(next);
    setDraft("");
    setBusy("Editing…");
    setError("");
    try {
      const data = await api.chat({
        messages: next.filter((m) => m.role === "user" || m.role === "assistant").map(({ role, content: c }) => ({ role, content: c })),
        playhead,
        selectedClipId,
      });
      setProject(data.project);
      if (data.applied && data.version) setView("program");
      setMessages([...next, { role: "assistant", content: data.reply, ops: data.ops, applied: data.applied, error: data.error }]);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: `I couldn't do that: ${err.message}` }]);
    } finally {
      setBusy("");
    }
  };

  const toggleMic = () => {
    if (!speechSupported) return;
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Rec();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onstart = () => setListening(true);
    rec.onerror = () => setListening(false);
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    rec.onresult = (event) => {
      let finalText = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interim += piece;
      }
      if (finalText) sendChat(finalText);
      else if (interim) setDraft(interim);
    };
    recognitionRef.current = rec;
    rec.start();
  };

  const onReorderDrop = async (targetId, event) => {
    event.preventDefault();
    setTimelineDrop(false);
    if (event.dataTransfer.files?.length) {
      await onFiles(event.dataTransfer.files);
      return;
    }
    const fromId = event.dataTransfer.getData("text/clip-id");
    if (!fromId || !project || fromId === targetId) return;
    const timeline = project.timeline.slice();
    const from = timeline.indexOf(fromId);
    const to = timeline.indexOf(targetId);
    if (from < 0 || to < 0) return;
    timeline.splice(from, 1);
    timeline.splice(to, 0, fromId);
    try {
      const data = await api.reorder(timeline);
      setProject(data.project);
    } catch (err) {
      setError(err.message);
    }
  };

  const restore = async (id) => {
    setBusy("Restoring…");
    try {
      const data = await api.restore(id);
      setProject(data.project);
      setView("program");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            ◇
          </span>
          <div>
            <h1>Clipwright</h1>
            <p>A Grok-powered video editor</p>
          </div>
        </div>
        <div className="top-meta">
          {health && (
            <span className={`pill ${health.mockMode ? "warn" : "ok"}`}>
              {health.mockMode ? "Mock assistant" : `Grok · ${health.model}`}
            </span>
          )}
          {busy && <span className="pill busy">{busy}</span>}
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Add videos
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,.mp4,.mov,.m4v,.webm,.mkv"
            multiple
            hidden
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          {error}
          <button type="button" onClick={() => setError("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="studio">
        <section className="stage-col">
          <div
            className={`stage ${dropActive ? "active" : ""} ${preview ? "has-media" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDropActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={onStageDrop}
          >
            {preview ? (
              <>
                {preview.kind === "audio" ? (
                  <div className="audio-card">
                    <p>Audio version</p>
                    <audio ref={videoRef} src={preview.url} controls onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)} />
                  </div>
                ) : (
                  <video
                    ref={videoRef}
                    src={preview.url}
                    controls
                    playsInline
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                  />
                )}
                <div className="stage-caption">
                  <span>{preview.label}</span>
                  <span className="mono">
                    {formatTime(currentTime)} / {formatTime(preview.duration)}
                    {playing ? " · playing" : ""}
                  </span>
                  {currentVersion && (
                    <div className="view-toggle">
                      <button type="button" className={view !== "clip" ? "on" : ""} onClick={() => setView("program")}>
                        Program
                      </button>
                      <button
                        type="button"
                        className={view === "clip" ? "on" : ""}
                        onClick={() => setView("clip")}
                        disabled={!selectedClip}
                      >
                        Source
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-stage">
                <strong>Drop videos here</strong>
                <span>Or use Add videos. Then talk to Grok in the panel on the right.</span>
                <button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>
                  Choose files
                </button>
              </div>
            )}
          </div>

          <div
            className={`timeline ${timelineDrop ? "active" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setTimelineDrop(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => setTimelineDrop(false)}
            onDrop={(e) => {
              e.preventDefault();
              setTimelineDrop(false);
              if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
            }}
          >
            <div className="timeline-head">
              <h2>Clip list</h2>
              <p>Drop videos here to add them. Drag clips to reorder.</p>
            </div>
            <ol className="clips">
              {(project?.timeline || []).map((id, index) => {
                const clip = clipsById.get(id);
                if (!clip) return null;
                return (
                  <li
                    key={id}
                    className={selectedClipId === id ? "selected" : ""}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/clip-id", id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") ? "copy" : "move";
                    }}
                    onDrop={(e) => onReorderDrop(id, e)}
                    onClick={() => {
                      setSelectedClipId(id);
                      setView("clip");
                    }}
                  >
                    <span className="idx">{index + 1}</span>
                    <span className="name">{clip.name}</span>
                    <span className="mono dim">{formatTime(clip.duration)}</span>
                  </li>
                );
              })}
              {(!project || project.timeline.length === 0) && (
                <li className="placeholder">The clip list is empty — drop a video onto this row.</li>
              )}
            </ol>
          </div>

          <div className="versions">
            <div className="timeline-head">
              <h2>Versions</h2>
              <p>Every edit is saved. Restore one to undo.</p>
            </div>
            <ul>
              {(project?.versions || []).slice().reverse().map((v) => (
                <li key={v.id} className={v.id === project.currentVersionId ? "current" : ""}>
                  <button type="button" onClick={() => restore(v.id)}>
                    <strong>{v.label}</strong>
                    <span className="mono dim">
                      {formatTime(v.duration)} · {new Date(v.createdAt).toLocaleTimeString()}
                    </span>
                  </button>
                </li>
              ))}
              {(!project || project.versions.length === 0) && <li className="placeholder">Edits will show up here.</li>}
            </ul>
          </div>
        </section>

        <aside className="chat-dock" aria-label="Grok assistant">
          <div className="chat-head">
            <h2>Grok</h2>
            <p>Talk or type an edit. Actions use the same validated operations as the chat.</p>
          </div>
          <div className="chips" role="list">
            {QUICK_CHIPS.map((chip) => (
              <button key={chip.id} type="button" role="listitem" className="chip" onClick={() => sendChat(chip.prompt)} disabled={Boolean(busy)}>
                {chip.label}
              </button>
            ))}
          </div>
          <div className="log">
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                <p>{m.content}</p>
              </div>
            ))}
            {busy && <div className="bubble assistant pending">{busy}</div>}
            <div ref={chatEndRef} />
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              sendChat(draft);
            }}
          >
            <button
              type="button"
              className={`mic ${listening ? "on" : ""}`}
              onClick={toggleMic}
              disabled={!speechSupported}
              title={
                speechSupported
                  ? listening
                    ? "Stop listening"
                    : "Talk to Grok"
                  : "Speech recognition is not available in this browser"
              }
              aria-label={speechSupported ? "Talk to Grok" : "Speech not supported"}
            >
              {listening ? "●" : "🎙"}
            </button>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. cut the first 5 seconds"
              aria-label="Message Grok"
              disabled={Boolean(busy)}
            />
            <button type="submit" className="btn primary" disabled={Boolean(busy) || !draft.trim()}>
              Send
            </button>
          </form>
        </aside>
      </main>
    </div>
  );
}

const QUICK_CHIPS = [
  { id: "trim", label: "Trim", prompt: "Trim the current video to the first 10 seconds." },
  { id: "cut_playhead", label: "Cut at playhead", prompt: "Cut the current video at the playhead." },
  { id: "split", label: "Split", prompt: "Split the current clip at the playhead." },
  { id: "merge", label: "Merge clips", prompt: "Merge all clips on the timeline into one program." },
  { id: "speed", label: "Speed up", prompt: "Speed the current video up to 1.5x." },
  { id: "captions", label: "Add captions", prompt: "Add captions — ask me what they should say if I haven't given text." },
  { id: "fade", label: "Fade in/out", prompt: "Add a fade in and fade out." },
  { id: "crop", label: "Crop to 9:16", prompt: "Crop the current video to 9:16." },
  { id: "mute", label: "Mute", prompt: "Mute the audio." },
  { id: "extract", label: "Extract audio", prompt: "Extract the audio from the current video." },
];
