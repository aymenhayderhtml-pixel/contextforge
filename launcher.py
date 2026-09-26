#!/usr/bin/env python3
"""
ContextForge - Desktop Launcher & Server Manager
Starts the local dev tool server and launches the browser application with 1-click.
"""

import os
import sys
import time
import signal
import socket
import webbrowser
import threading
import subprocess
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

# Ensure user node directory is in PATH
USER_NODE_DIR = os.path.expanduser("~/.local/node/bin")
if os.path.isdir(USER_NODE_DIR) and USER_NODE_DIR not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{USER_NODE_DIR}:{os.environ.get('PATH', '')}"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = SCRIPT_DIR
PORT = 3000
SERVER_URL = f"http://localhost:{PORT}/"
ICON_PATH = os.path.join(SCRIPT_DIR, "contextforge_icon.png")


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


class ContextForgeLauncherApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("ContextForge — Local Dev Workbench")
        self.root.geometry("820x600")
        self.root.minsize(720, 500)

        # Palette matching ContextForge dark UI theme
        self.bg_dark = "#090d16"
        self.bg_card = "#111827"
        self.bg_surface = "#1f2937"
        self.border_col = "#374151"
        self.primary_accent = "#38bdf8"
        self.secondary_accent = "#6366f1"
        self.text_light = "#f9fafb"
        self.text_muted = "#9ca3af"
        self.success_color = "#34d399"
        self.danger_color = "#f87171"
        self.warning_color = "#fbbf24"

        self.root.configure(bg=self.bg_dark)

        # Set window icon if available
        if os.path.exists(ICON_PATH):
            try:
                icon_img = tk.PhotoImage(file=ICON_PATH)
                self.root.iconphoto(True, icon_img)
                self._icon_ref = icon_img
            except Exception:
                pass

        self.server_proc = None
        self.is_running = False

        self._build_ui()
        self._check_initial_port()

        # Handle window close cleanly
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _build_ui(self):
        # Header Frame
        header = tk.Frame(self.root, bg=self.bg_card, bd=0, highlightthickness=1, highlightbackground=self.border_col)
        header.pack(fill="x", padx=16, pady=(16, 8))

        title_frame = tk.Frame(header, bg=self.bg_card)
        title_frame.pack(fill="x", padx=16, pady=14)

        title_label = tk.Label(
            title_frame,
            text="⚡ ContextForge",
            font=("DejaVu Sans", 18, "bold"),
            fg=self.primary_accent,
            bg=self.bg_card
        )
        title_label.pack(side="left")

        version_badge = tk.Label(
            title_frame,
            text="v0.1.0 • Game Factory Workbench",
            font=("DejaVu Sans", 10),
            fg=self.text_muted,
            bg=self.bg_surface,
            padx=8,
            pady=2
        )
        version_badge.pack(side="left", padx=12)

        sub_label = tk.Label(
            header,
            text="Local Architectural Workbench & Dependency Graph for Godot 4.x & Web Games",
            font=("DejaVu Sans", 10),
            fg=self.text_muted,
            bg=self.bg_card
        )
        sub_label.pack(anchor="w", padx=16, pady=(0, 14))

        # Status & Controls Card
        control_frame = tk.Frame(self.root, bg=self.bg_card, highlightthickness=1, highlightbackground=self.border_col)
        control_frame.pack(fill="x", padx=16, pady=8)

        status_row = tk.Frame(control_frame, bg=self.bg_card)
        status_row.pack(fill="x", padx=16, pady=(14, 10))

        tk.Label(status_row, text="Status:", font=("DejaVu Sans", 11, "bold"), fg=self.text_light, bg=self.bg_card).pack(side="left")

        self.status_dot = tk.Label(status_row, text="●", font=("DejaVu Sans", 14), fg=self.danger_color, bg=self.bg_card)
        self.status_dot.pack(side="left", padx=(8, 4))

        self.status_text = tk.Label(
            status_row,
            text="STOPPED (Port 3000 inactive)",
            font=("DejaVu Sans", 11),
            fg=self.danger_color,
            bg=self.bg_card
        )
        self.status_text.pack(side="left")

        self.url_btn = tk.Label(
            status_row,
            text=f"[{SERVER_URL}]",
            font=("DejaVu Sans", 10, "underline"),
            fg=self.primary_accent,
            bg=self.bg_card,
            cursor="hand2"
        )
        self.url_btn.pack(side="right")
        self.url_btn.bind("<Button-1>", lambda e: self.open_browser())

        # Buttons Row
        btn_row = tk.Frame(control_frame, bg=self.bg_card)
        btn_row.pack(fill="x", padx=16, pady=(0, 14))

        self.start_btn = tk.Button(
            btn_row,
            text="🚀 Start Server & Open App",
            font=("DejaVu Sans", 11, "bold"),
            bg="#0284c7",
            fg="#ffffff",
            activebackground="#0369a1",
            activeforeground="#ffffff",
            relief="flat",
            padx=16,
            pady=8,
            cursor="hand2",
            command=self.start_server
        )
        self.start_btn.pack(side="left", padx=(0, 8))

        self.stop_btn = tk.Button(
            btn_row,
            text="⏹ Stop Server",
            font=("DejaVu Sans", 10),
            bg=self.bg_surface,
            fg=self.text_light,
            activebackground="#374151",
            activeforeground="#ffffff",
            relief="flat",
            padx=12,
            pady=8,
            cursor="hand2",
            state="disabled",
            command=self.stop_server
        )
        self.stop_btn.pack(side="left", padx=(0, 8))

        self.restart_btn = tk.Button(
            btn_row,
            text="🔄 Restart",
            font=("DejaVu Sans", 10),
            bg=self.bg_surface,
            fg=self.text_light,
            activebackground="#374151",
            activeforeground="#ffffff",
            relief="flat",
            padx=12,
            pady=8,
            cursor="hand2",
            state="disabled",
            command=self.restart_server
        )
        self.restart_btn.pack(side="left", padx=(0, 8))

        self.browser_btn = tk.Button(
            btn_row,
            text="🌐 Open Browser",
            font=("DejaVu Sans", 10),
            bg=self.bg_surface,
            fg=self.text_light,
            activebackground="#374151",
            activeforeground="#ffffff",
            relief="flat",
            padx=12,
            pady=8,
            cursor="hand2",
            command=self.open_browser
        )
        self.browser_btn.pack(side="left", padx=(0, 8))

        self.test_btn = tk.Button(
            btn_row,
            text="🧪 Run Tests",
            font=("DejaVu Sans", 10),
            bg=self.bg_surface,
            fg=self.text_muted,
            activebackground="#374151",
            activeforeground="#ffffff",
            relief="flat",
            padx=12,
            pady=8,
            cursor="hand2",
            command=self.run_tests
        )
        self.test_btn.pack(side="right")

        # Live Console Output Card
        terminal_frame = tk.Frame(self.root, bg=self.bg_card, highlightthickness=1, highlightbackground=self.border_col)
        terminal_frame.pack(fill="both", expand=True, padx=16, pady=(8, 16))

        term_header = tk.Frame(terminal_frame, bg=self.bg_card)
        term_header.pack(fill="x", padx=12, pady=(10, 6))

        tk.Label(
            term_header,
            text="Server Log Activity",
            font=("DejaVu Sans", 10, "bold"),
            fg=self.text_light,
            bg=self.bg_card
        ).pack(side="left")

        clear_btn = tk.Button(
            term_header,
            text="Clear Log",
            font=("DejaVu Sans", 9),
            bg=self.bg_surface,
            fg=self.text_muted,
            relief="flat",
            padx=8,
            pady=2,
            command=self.clear_logs
        )
        clear_btn.pack(side="right")

        self.log_widget = scrolledtext.ScrolledText(
            terminal_frame,
            bg="#030712",
            fg="#d1d5db",
            insertbackground="#ffffff",
            font=("DejaVu Sans Mono", 9),
            bd=0,
            padx=10,
            pady=10
        )
        self.log_widget.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        self.log_widget.tag_configure("stdout", foreground="#d1d5db")
        self.log_widget.tag_configure("stderr", foreground="#f87171")
        self.log_widget.tag_configure("system", foreground="#38bdf8")
        self.log_widget.tag_configure("success", foreground="#34d399")

        self._append_log("ContextForge launcher initialized.\n", "system")
        self._append_log(f"Project directory: {PROJECT_DIR}\n", "system")

    def _append_log(self, text: str, tag: str = "stdout"):
        def _do():
            self.log_widget.insert(tk.END, text, tag)
            self.log_widget.see(tk.END)
        self.root.after(0, _do)

    def clear_logs(self):
        self.log_widget.delete("1.0", tk.END)

    def _check_initial_port(self):
        if is_port_in_use(PORT):
            self.is_running = True
            self.status_dot.config(fg=self.success_color)
            self.status_text.config(text=f"RUNNING on port {PORT} (external process)", fg=self.success_color)
            self.start_btn.config(state="disabled")
            self.stop_btn.config(state="normal")
            self.restart_btn.config(state="normal")
            self._append_log(f"Detected existing server active at {SERVER_URL}\n", "success")

    def start_server(self):
        if self.is_running:
            return

        self._append_log("Starting ContextForge server (node server/index.js)...\n", "system")
        self.start_btn.config(state="disabled")
        self.status_text.config(text="STARTING...", fg=self.warning_color)
        self.status_dot.config(fg=self.warning_color)

        thread = threading.Thread(target=self._run_server_thread, daemon=True)
        thread.start()

    def _run_server_thread(self):
        node_bin = "node"
        if os.path.exists(os.path.join(USER_NODE_DIR, "node")):
            node_bin = os.path.join(USER_NODE_DIR, "node")

        cmd = [node_bin, "server/index.js"]

        try:
            # Launch in separate process group so children are cleanly terminated
            self.server_proc = subprocess.Popen(
                cmd,
                cwd=PROJECT_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                preexec_fn=os.setsid
            )
            self.is_running = True

            self.root.after(0, lambda: self.stop_btn.config(state="normal"))
            self.root.after(0, lambda: self.restart_btn.config(state="normal"))

            # Start stdout and stderr reader threads
            threading.Thread(target=self._stream_output, args=(self.server_proc.stdout, "stdout"), daemon=True).start()
            threading.Thread(target=self._stream_output, args=(self.server_proc.stderr, "stderr"), daemon=True).start()

            # Poll for port ready
            ready = False
            for _ in range(40):
                if is_port_in_use(PORT):
                    ready = True
                    break
                if self.server_proc.poll() is not None:
                    break
                time.sleep(0.2)

            if ready:
                self.root.after(0, lambda: self._on_server_ready())
            else:
                self.root.after(0, lambda: self._on_server_failed())

        except Exception as e:
            self._append_log(f"Failed to start server: {e}\n", "stderr")
            self.root.after(0, self._set_stopped_state)

    def _stream_output(self, stream, tag):
        try:
            for line in iter(stream.readline, ''):
                if line:
                    self._append_log(line, tag)
            stream.close()
        except Exception:
            pass

    def _on_server_ready(self):
        self.status_dot.config(fg=self.success_color)
        self.status_text.config(text=f"RUNNING at {SERVER_URL}", fg=self.success_color)
        self._append_log(f"Server is online! Opening {SERVER_URL} in browser...\n", "success")
        self.open_browser()

    def _on_server_failed(self):
        self._append_log("Server process exited unexpectedly or timed out binding port 3000.\n", "stderr")
        self._set_stopped_state()

    def _set_stopped_state(self):
        self.is_running = False
        self.status_dot.config(fg=self.danger_color)
        self.status_text.config(text="STOPPED (Port 3000 inactive)", fg=self.danger_color)
        self.start_btn.config(state="normal")
        self.stop_btn.config(state="disabled")
        self.restart_btn.config(state="disabled")

    def stop_server(self):
        self._append_log("Stopping ContextForge server...\n", "system")
        if self.server_proc:
            try:
                os.killpg(os.getpgid(self.server_proc.pid), signal.SIGTERM)
                self.server_proc.wait(timeout=3)
            except Exception:
                try:
                    os.killpg(os.getpgid(self.server_proc.pid), signal.SIGKILL)
                except Exception:
                    pass
            self.server_proc = None

        # Check if external process is holding port 3000
        if is_port_in_use(PORT):
            try:
                subprocess.run(["fuser", "-k", f"{PORT}/tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(0.5)
            except Exception:
                pass

        self._append_log("Server stopped successfully.\n", "system")
        self._set_stopped_state()

    def restart_server(self):
        self.stop_server()
        self.root.after(1000, self.start_server)

    def open_browser(self):
        try:
            webbrowser.open(SERVER_URL)
        except Exception as e:
            self._append_log(f"Could not open browser automatically: {e}\n", "stderr")

    def run_tests(self):
        self._append_log("Running test suite (npm test)...\n", "system")
        self.test_btn.config(state="disabled")

        def _test_task():
            npm_bin = "npm"
            if os.path.exists(os.path.join(USER_NODE_DIR, "npm")):
                npm_bin = os.path.join(USER_NODE_DIR, "npm")
            try:
                res = subprocess.run([npm_bin, "test"], cwd=PROJECT_DIR, capture_output=True, text=True)
                self._append_log(res.stdout, "stdout")
                if res.stderr:
                    self._append_log(res.stderr, "stderr")
                if res.returncode == 0:
                    self._append_log("\nAll tests passed successfully! [SUCCESS]\n", "success")
                else:
                    self._append_log(f"\nTests failed with exit code {res.returncode}.\n", "stderr")
            except Exception as e:
                self._append_log(f"Test run error: {e}\n", "stderr")
            finally:
                self.root.after(0, lambda: self.test_btn.config(state="normal"))

        threading.Thread(target=_test_task, daemon=True).start()

    def on_close(self):
        if self.server_proc:
            try:
                os.killpg(os.getpgid(self.server_proc.pid), signal.SIGTERM)
            except Exception:
                pass
        self.root.destroy()


def main():
    root = tk.Tk()
    app = ContextForgeLauncherApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
