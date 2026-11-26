async function request(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  health: () => request("/api/health"),
  project: () => request("/api/project"),
  actions: () => request("/api/actions"),
  async upload(files) {
    const body = new FormData();
    for (const file of files) body.append("files", file);
    return request("/api/upload", { method: "POST", body });
  },
  reorder(timeline) {
    return request("/api/timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeline }),
    });
  },
  chat({ messages, playhead, selectedClipId }) {
    return request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, playhead, selectedClipId }),
    });
  },
  ops({ ops, summary, playhead, selectedClipId }) {
    return request("/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops, summary, playhead, selectedClipId }),
    });
  },
  restore(id) {
    return request(`/api/versions/${id}/restore`, { method: "POST" });
  },
};
