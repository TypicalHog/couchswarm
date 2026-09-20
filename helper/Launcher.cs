using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// The room's palette (app/globals.css), painted with GDI+ because WinForms ships no dark controls.
// High Contrast replaces it with the four colours the user chose there, including the one the text boxes
// draw their cue text in. The theme is read once, so switching it needs the helper reopened.
static class Skin {
    public static readonly bool Contrast = SystemInformation.HighContrast;
    public static readonly Color Ground = Contrast ? SystemColors.Window : Color.FromArgb(16, 20, 17);
    public static readonly Color Surface = Contrast ? SystemColors.Window : Color.FromArgb(25, 30, 26);
    public static readonly Color Field = Contrast ? SystemColors.Window : Color.FromArgb(20, 26, 20);
    public static readonly Color Edge = Contrast ? SystemColors.WindowText : Color.FromArgb(44, 52, 45);
    // Edge is 1.32:1 against Surface: enough for the card's own border, invisible as the boundary of a control.
    // Text boxes and the unchecked box take the website's input border instead (app/globals.css .text-input),
    // which clears WCAG 1.4.11's 3:1 at 3.80:1.
    public static readonly Color FieldEdge = Contrast ? SystemColors.WindowText : Color.FromArgb(107, 125, 94);
    public static readonly Color Lime = Contrast ? SystemColors.Highlight : Color.FromArgb(194, 242, 138);
    public static readonly Color LimeLift = Contrast ? SystemColors.Highlight : Color.FromArgb(210, 255, 162);
    public static readonly Color LimePress = Contrast ? SystemColors.Highlight : Color.FromArgb(173, 221, 121);
    public static readonly Color OnLime = Contrast ? SystemColors.HighlightText : Color.FromArgb(23, 34, 21);
    public static readonly Color Ink = Contrast ? SystemColors.WindowText : Color.FromArgb(239, 243, 237);
    public static readonly Color Muted = Contrast ? SystemColors.GrayText : Color.FromArgb(163, 173, 156);
    public static readonly Color Alarm = Contrast ? SystemColors.WindowText : Color.FromArgb(242, 142, 134);
    public static readonly Color Ghost = Contrast ? SystemColors.Window : Color.FromArgb(27, 33, 28);
    public static readonly Color GhostLift = Contrast ? SystemColors.Window : Color.FromArgb(41, 49, 41);
    public static readonly Color GhostPress = Contrast ? SystemColors.Window : Color.FromArgb(34, 41, 34);
    public static readonly Color GhostEdge = Contrast ? SystemColors.WindowText : Color.FromArgb(58, 68, 59);
    public static readonly Color GhostEdgeLift = Contrast ? SystemColors.Highlight : Color.FromArgb(86, 97, 79);

    public static Color Mix(Color from, Color to, double amount) {
        // High Contrast has no shades between its colours: a foreground that would fade into the card takes the
        // system's disabled grey instead, and a surface that would take on a tint stays the surface it is.
        if (Contrast) return from == Surface ? from : Muted;
        return Color.FromArgb((int)(from.R + (to.R - from.R) * amount), (int)(from.G + (to.G - from.G) * amount), (int)(from.B + (to.B - from.B) * amount));
    }
    // Painted geometry is in 96-DPI units; the form scales control bounds, this scales what we draw inside them.
    public static float Scale(Graphics canvas) { return canvas.DpiX / 96f; }
    public static GraphicsPath Round(Rectangle bounds, int radius) {
        int corner = Math.Max(2, radius * 2);
        var path = new GraphicsPath();
        path.AddArc(bounds.X, bounds.Y, corner, corner, 180, 90);
        path.AddArc(bounds.Right - corner, bounds.Y, corner, corner, 270, 90);
        path.AddArc(bounds.Right - corner, bounds.Bottom - corner, corner, corner, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - corner, corner, corner, 90, 90);
        path.CloseFigure();
        return path;
    }
    public static void Plate(Graphics canvas, Rectangle bounds, int radius, Color fill, Color edge) {
        using (var path = Round(bounds, radius))
        using (var brush = new SolidBrush(fill))
        using (var pen = new Pen(edge)) { canvas.FillPath(brush, path); canvas.DrawPath(pen, path); }
    }
    public static void Outline(Graphics canvas, Rectangle bounds, int radius, Color edge) {
        using (var path = Round(bounds, radius))
        using (var pen = new Pen(edge)) canvas.DrawPath(pen, path);
    }
}

// A surface panel. Text boxes on it are borderless and the card paints their field frame,
// so the frame always fits the height the scaled font gives the box.
class Card : Panel {
    public const int PadX = 13, PadY = 10;
    public Color Dot = Color.Empty;

    public Card() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Skin.Surface;
    }
    protected override void OnControlAdded(ControlEventArgs e) {
        base.OnControlAdded(e);
        if (e.Control is TextBox) { e.Control.GotFocus += Repaint; e.Control.LostFocus += Repaint; }
    }
    void Repaint(object sender, EventArgs e) { Invalidate(); }
    protected override void OnPaint(PaintEventArgs e) {
        float scale = Skin.Scale(e.Graphics);
        e.Graphics.Clear(Parent.BackColor);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Skin.Plate(e.Graphics, new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), (int)(14 * scale), Skin.Surface, Skin.Edge);
        foreach (Control child in Controls) {
            var box = child as TextBox;
            if (box == null) continue;
            var field = Rectangle.Inflate(box.Bounds, (int)(PadX * scale), (int)(PadY * scale));
            Skin.Plate(e.Graphics, field, (int)(8 * scale), Skin.Field, box.Focused ? Skin.Lime : Skin.FieldEdge);
        }
        if (Dot.IsEmpty) return;
        int size = (int)(9 * scale);
        using (var brush = new SolidBrush(Dot)) e.Graphics.FillEllipse(brush, (int)(23 * scale), (int)(18 * scale) + Font.Height / 2 - size / 2, size, size);
    }
}

class FlatButton : Button {
    public bool Primary;
    bool hover, held;

    public FlatButton() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        Cursor = Cursors.Hand;
    }
    protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover = true; Invalidate(); }
    protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover = held = false; Invalidate(); }
    protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); held = true; Invalidate(); }
    protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); held = false; Invalidate(); }
    protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); hover = held = false; Invalidate(); }
    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
    protected override void OnPaint(PaintEventArgs e) {
        float scale = Skin.Scale(e.Graphics);
        e.Graphics.Clear(Parent.BackColor);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Color face, edge, label;
        if (!Enabled) {
            face = Primary ? Skin.Mix(Skin.Surface, Skin.Lime, 0.22) : Skin.Surface;
            edge = Primary ? face : Skin.Mix(Skin.Edge, Skin.Surface, 0.4);
            label = Skin.Mix(Skin.Muted, Skin.Surface, Primary ? 0.35 : 0.5);
        } else if (Primary) {
            face = held ? Skin.LimePress : hover ? Skin.LimeLift : Skin.Lime;
            edge = face;
            label = Skin.OnLime;
        } else {
            face = held ? Skin.GhostPress : hover ? Skin.GhostLift : Skin.Ghost;
            edge = hover ? Skin.GhostEdgeLift : Skin.GhostEdge;
            label = Skin.Ink;
        }
        var body = new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
        Skin.Plate(e.Graphics, body, (int)(8 * scale), face, edge);
        if (Focused && Enabled) {
            int inset = (int)(4 * scale);
            Skin.Outline(e.Graphics, Rectangle.Inflate(body, -inset, -inset), (int)(5 * scale), Primary ? Skin.OnLime : Skin.Lime);
        }
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, label,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

class Check : CheckBox {
    bool hover;

    public Check() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        AutoSize = false;
        Cursor = Cursors.Hand;
    }
    protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover = true; Invalidate(); }
    protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover = false; Invalidate(); }
    protected override void OnCheckedChanged(EventArgs e) { base.OnCheckedChanged(e); Invalidate(); }
    protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); hover = false; Invalidate(); }
    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
    protected override void OnPaint(PaintEventArgs e) {
        float scale = Skin.Scale(e.Graphics);
        e.Graphics.Clear(Parent.BackColor);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        int size = (int)(20 * scale);
        var box = new Rectangle(1, (ClientSize.Height - size) / 2, size, size);
        Color face = Checked ? (Enabled ? Skin.Lime : Skin.Mix(Skin.Surface, Skin.Lime, 0.22)) : Skin.Field;
        Color edge = !Enabled ? Skin.Mix(Skin.FieldEdge, Skin.Surface, 0.4) : Checked ? face : hover ? Skin.Mix(Skin.FieldEdge, Skin.Lime, 0.45) : Skin.FieldEdge;
        Skin.Plate(e.Graphics, box, (int)(6 * scale), face, edge);
        if (Checked) {
            using (var pen = new Pen(Enabled ? Skin.OnLime : Skin.Mix(Skin.OnLime, Skin.Surface, 0.45), Math.Max(2f, 2f * scale))) {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
                e.Graphics.DrawLines(pen, new PointF[] {
                    new PointF(box.Left + size * 0.26f, box.Top + size * 0.52f),
                    new PointF(box.Left + size * 0.43f, box.Top + size * 0.70f),
                    new PointF(box.Left + size * 0.75f, box.Top + size * 0.30f),
                });
            }
        }
        int text = box.Right + (int)(13 * scale);
        TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(text, 0, ClientSize.Width - text, ClientSize.Height),
            Enabled ? Skin.Ink : Skin.Mix(Skin.Muted, Skin.Surface, 0.5),
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        if (Focused) Skin.Outline(e.Graphics, new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), (int)(6 * scale), Skin.Lime);
    }
}

class Mark : Control {
    public Mark() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        // A logo, not an input: keep it out of the tab cycle, where it was a stop that showed nothing and did nothing.
        SetStyle(ControlStyles.Selectable, false);
        TabStop = false;
        AccessibleRole = AccessibleRole.Graphic;
        AccessibleName = "CouchSwarm";
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.Clear(Parent.BackColor);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Skin.Plate(e.Graphics, new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), ClientSize.Height * 28 / 100, Skin.Lime, Skin.Lime);
        using (var glyph = new Font(Font.FontFamily, ClientSize.Height * 0.46f, FontStyle.Bold, GraphicsUnit.Pixel))
            TextRenderer.DrawText(e.Graphics, "C", glyph, ClientRectangle, Skin.OnLime, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
}

class CouchSwarmHelper : Form {
    const string DefaultFolder = "%LOCALAPPDATA%\\CouchSwarm\\downloads";
    readonly Card linkCard = new Card(), diskCard = new Card(), statusCard = new Card();
    readonly TextBox link = new TextBox(), folder = new TextBox();
    readonly Label status = new Label(), meta = new Label();
    readonly FlatButton pair = new FlatButton(), stop = new FlatButton(), browse = new FlatButton();
    readonly Check keep = new Check();
    readonly ToolTip tips = new ToolTip();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    Process helper;
    bool quitting, running, spoke;
    int viewers;
    string lastLink = "", site = "";

    CouchSwarmHelper() {
        Text = "CouchSwarm Helper";
        ClientSize = new Size(560, 628);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Skin.Ground;
        ForeColor = Skin.Ink;
        Font = new Font("Segoe UI", 10F);

        var mark = new Mark();
        mark.SetBounds(28, 26, 42, 42);
        var wordmark = new Label { Text = "CouchSwarm", Font = new Font("Segoe UI", 16F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
        wordmark.SetBounds(84, 26, 340, 26);
        var tagline = new Label { Text = "Your computer brings the movie. Everyone brings a couch.", ForeColor = Skin.Muted, Font = new Font("Segoe UI", 9F), TextAlign = ContentAlignment.MiddleLeft };
        tagline.SetBounds(86, 52, 420, 20);
        // An empty name still borrows the tagline above, so give the divider one of its own.
        var rule = new Panel { BackColor = Skin.Edge, AccessibleName = " ", AccessibleRole = AccessibleRole.Separator };
        rule.SetBounds(28, 96, 504, 1);

        linkCard.SetBounds(28, 112, 504, 164);
        Group(linkCard, "Pairing link");
        var linkTitle = Eyebrow("PAIRING LINK FROM YOUR ROOM");
        linkTitle.SetBounds(24, 18, 456, 18);
        Dress(link);
        link.SetBounds(37, 52, 430, 20);
        pair.Text = "Connect to room"; pair.Primary = true; pair.SetBounds(24, 100, 190, 42);
        stop.Text = "Stop sharing"; stop.Enabled = false; stop.SetBounds(226, 100, 156, 42);
        linkCard.Controls.AddRange(new Control[] { linkTitle, link, pair, stop });

        diskCard.SetBounds(28, 292, 504, 170);
        Group(diskCard, "Download folder");
        var diskTitle = Eyebrow("DOWNLOAD FOLDER");
        diskTitle.SetBounds(24, 18, 456, 18);
        Dress(folder);
        folder.SetBounds(37, 52, 300, 20);
        // The box shows about 42 characters of a path, so keep the whole (expanded) one a hover away.
        folder.TextChanged += (s, e) => tips.SetToolTip(folder, Environment.ExpandEnvironmentVariables(folder.Text));
        browse.Text = "Browse…"; browse.SetBounds(362, 42, 118, 40);
        keep.Text = "Keep downloads when I close"; keep.Checked = true; keep.SetBounds(23, 98, 456, 26);
        var keepHint = new Label { Text = "Turn this off to delete the movie when you stop sharing or close.", ForeColor = Skin.Muted, Font = new Font("Segoe UI", 8.5F), TextAlign = ContentAlignment.MiddleLeft };
        keepHint.SetBounds(24, 128, 456, 20);
        diskCard.Controls.AddRange(new Control[] { diskTitle, folder, browse, keep, keepHint });

        statusCard.SetBounds(28, 478, 504, 126);
        Group(statusCard, "Status");
        statusCard.Dot = Skin.Muted;
        status.Text = "Open your room, choose Connect your helper, and copy a pairing link.";
        // Three lines: the longest real message (a rejected torrent plus its retry advice) needs 57px.
        status.SetBounds(46, 18, 434, 76);
        status.AutoEllipsis = true;
        // This card is the only feedback surface and never takes focus, so Narrator needs it announced.
        status.LiveSetting = System.Windows.Forms.Automation.AutomationLiveSetting.Polite;
        meta.ForeColor = Skin.Muted; meta.Font = new Font("Segoe UI", 8.5F);
        meta.SetBounds(46, 96, 434, 18);
        // The paired site pushes this line past the card on a long host name.
        meta.AutoEllipsis = true;
        // Empty, this label borrows the status text above it and a screen reader reads that message twice.
        meta.Visible = false;
        meta.TextChanged += (s, e) => meta.Visible = meta.Text.Length > 0;
        statusCard.Controls.AddRange(new Control[] { status, meta });

        Controls.AddRange(new Control[] { mark, wordmark, tagline, rule, linkCard, diskCard, statusCard });
        // Scale only once every control and its bounds exist: asking for it on an empty form spends the
        // DPI factor on nothing, and the layout then keeps its 96-DPI pixels while the fonts grow.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        link.TabIndex = 0; pair.TabIndex = 1; stop.TabIndex = 2; folder.TabIndex = 3; browse.TabIndex = 4; keep.TabIndex = 5;
        AcceptButton = pair;

        pair.Click += (s, e) => {
            if (link.Text.Trim().Length == 0) { link.Focus(); return; }
            // Node expands neither %VARS% nor relative paths, and the helper's own folder is its working directory.
            string chosen = Environment.ExpandEnvironmentVariables(folder.Text.Trim());
            // Explorer's "Copy as path" pastes the quotes too, and Path.IsPathRooted throws on those and on '|':
            // an unparseable path is simply not rooted, and lands on the same status line instead of a crash dialog.
            // 'C:', 'C:Movies' and '\Movies' count as rooted but follow a drive's current folder, so Node resolves
            // them inside the helper's own app folder, where an update deletes the movies kept there: want a real root.
            bool rooted; try { rooted = Path.IsPathRooted(chosen) && Path.GetPathRoot(chosen).Length >= 3; } catch (ArgumentException) { rooted = false; }
            if (chosen.Length > 0 && !rooted) { folder.Focus(); Say("Choose the download folder with Browse.", Skin.Alarm); return; }
            // Only NTFS and ReFS can mark a file sparse. Elsewhere the first tail write an MKV needs
            // zero-fills and reserves the whole movie, and FAT32 cannot hold 4 GB at all, so refuse the
            // folder here rather than stall or report a full drive once the movie is already chosen.
            if (chosen.Length > 0) {
                string format = null;
                // A UNC share, a removable slot with no media and a drive the user cannot read all throw: let those through.
                try { format = new DriveInfo(Path.GetPathRoot(chosen)).DriveFormat; } catch {}
                if (format != null && format != "NTFS" && format != "ReFS") {
                    folder.Focus(); Say("That drive is " + format + " and cannot store a movie in pieces. Choose a folder on an NTFS drive.", Skin.Alarm); return;
                }
            }
            SetRunning(true);
            lastLink = link.Text.Trim();
            SaveSettings();
            Say("Connecting to your room…", Skin.Lime);
            Send(new { action = "pair", url = lastLink, folder = chosen, keepDownloads = keep.Checked });
            link.Clear();
        };
        stop.Click += (s, e) => {
            stop.Enabled = false;
            Say(keep.Checked ? "Stopping. Downloaded movies stay in your folder." : "Stopping and clearing temporary movie data…", Skin.Muted);
            Send(new { action = "stop" });
        };
        browse.Click += (s, e) => {
            using (var dialog = new FolderBrowserDialog()) {
                dialog.Description = "Choose where CouchSwarm saves downloaded movies.";
                dialog.ShowNewFolderButton = true;
                if (folder.Text.Trim().Length > 0) dialog.SelectedPath = folder.Text.Trim();
                if (dialog.ShowDialog(this) == DialogResult.OK) { folder.Text = dialog.SelectedPath; folder.SelectionStart = folder.Text.Length; folder.ScrollToCaret(); SaveSettings(); }
            }
        };
        Shown += (s, e) => {
            // This fixed client size scales past a small work area at high DPI, putting the status card off-screen.
            var work = Screen.FromControl(this).WorkingArea;
            // The window is too tall, never too wide: a minimum width of the whole client makes the vertical
            // bar squeeze it and WinForms adds a horizontal bar over the status card to scroll nothing.
            if (Height > work.Height) {
                AutoScrollMinSize = new Size(0, ClientSize.Height);
                Width += SystemInformation.VerticalScrollBarWidth;
                AutoScroll = true;
                Height = work.Height;
            }
            Align(); Cue(link, "Paste your pairing link here"); Cue(folder, DefaultFolder); link.Focus(); StartHelper();
        };
        FormClosing += (s, e) => {
            SaveSettings();
            if (helper == null || helper.HasExited) return;
            // Cancelling FormClosing on WM_QUERYENDSESSION vetoes the session end, so let shutdown and logoff through.
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing) {
                quitting = true;
                try { helper.StandardInput.Close(); } catch {}
                return;
            }
            // Closing stops the helper at once, and with it every friend's movie: worth one question first.
            if (!quitting && e.CloseReason == CloseReason.UserClosing && viewers > 0
                && MessageBox.Show(this, viewers + (viewers == 1 ? " friend is" : " friends are") + " watching through this helper. Closing it stops their movie.",
                    "CouchSwarm", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.OK) {
                e.Cancel = true;
                return;
            }
            e.Cancel = true;
            if (!quitting) {
                quitting = true;
                Enabled = false;
                Say(keep.Checked ? "Closing the helper. Downloaded movies stay in your folder." : "Closing the helper and clearing temporary movie data…", Skin.Muted);
                try { helper.StandardInput.Close(); } catch {}
                // The helper gives its own stop 15 seconds, but a pool thread stuck on a folder that stopped
                // answering keeps node.exe alive past that and Exited never fires, leaving a disabled window
                // nobody can close. Give it a little longer than the helper does, then end it here.
                var deadline = new System.Windows.Forms.Timer { Interval = 20000 };
                deadline.Tick += (s2, e2) => {
                    deadline.Stop();
                    try { if (!helper.HasExited) helper.Kill(); } catch {}
                    // Kill does not guarantee Exited either, so stop waiting for it.
                    helper = null;
                    Close();
                };
                deadline.Start();
            }
        };
        LoadSettings();
    }
    static Label Eyebrow(string text) {
        return new Label { Text = text, ForeColor = Skin.Muted, Font = new Font("Segoe UI", 8F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
    }
    // A card with no name of its own borrows the nearest text above it, which here is the tagline.
    static void Group(Card card, string name) { card.AccessibleName = name; card.AccessibleRole = AccessibleRole.Grouping; }
    static void Dress(TextBox box) { box.BorderStyle = BorderStyle.None; box.BackColor = Skin.Field; box.ForeColor = Skin.Ink; }
    static void Cue(TextBox box, string text) {
        try { SendMessage(box.Handle, 0x1501, (IntPtr)1, text); } catch {}
    }
    // Keep Browse flush with the field the card paints around the folder box, at whatever DPI this screen uses.
    void Align() {
        using (var canvas = CreateGraphics()) {
            float scale = Skin.Scale(canvas);
            int padX = (int)(Card.PadX * scale), padY = (int)(Card.PadY * scale);
            browse.SetBounds(folder.Right + padX + (int)(12 * scale), folder.Top - padY, browse.Width, folder.Height + padY * 2);
        }
    }
    void Say(string text, Color dot) { status.Text = text; statusCard.Dot = dot; statusCard.Invalidate(); }
    void SetRunning(bool value) {
        running = value;
        // Nothing a user-mode process sends over the network resets the idle timer, so a helper PC
        // nobody watches on sleeps mid-movie and every viewer stalls. The request is per thread and
        // SetRunning only runs on the UI thread; Stop, a helper error and process exit all release it.
        SetThreadExecutionState(value ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS);
        // Enable the successor before disabling the focused button: WinForms moves focus off a control it disables.
        if (value) { stop.Enabled = true; pair.Enabled = false; } else { pair.Enabled = true; stop.Enabled = false; }
        browse.Enabled = !value; keep.Enabled = !value; folder.ReadOnly = value;
    }
    static string SettingsPath() {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CouchSwarm", "settings.json");
    }
    void LoadSettings() {
        try {
            var data = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsPath()));
            if (data.ContainsKey("folder")) folder.Text = Convert.ToString(data["folder"]);
            if (data.ContainsKey("keepDownloads")) keep.Checked = Convert.ToBoolean(data["keepDownloads"]);
        } catch {}
    }
    void SaveSettings() {
        try {
            string file = SettingsPath();
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, json.Serialize(new Dictionary<string, object> { { "folder", folder.Text.Trim() }, { "keepDownloads", keep.Checked } }));
        } catch {}
    }
    void Send(object command) {
        try {
            if (helper == null || helper.HasExited) StartHelper();
            // .NET Framework builds StandardInput with Console.InputEncoding (the ANSI code page in a
            // windowless app); desktop.mjs reads UTF-8, so write the bytes ourselves.
            var bytes = new UTF8Encoding(false).GetBytes(json.Serialize(command) + "\n");
            helper.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
            helper.StandardInput.BaseStream.Flush();
        }
        catch { Say("Could not start the helper. Extract the whole ZIP and try again.", Skin.Alarm); SetRunning(false); }
    }
    void OnUi(Action action) { if (!IsDisposed && IsHandleCreated) { try { BeginInvoke(action); } catch (InvalidOperationException) {} } }
    void StartHelper() {
        if (helper != null && !helper.HasExited) return;
        spoke = false;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        // Antivirus HTTPS scanning and company TLS inspection put their root in the Windows store only,
        // so without --use-system-ca every pairing fetch fails with a bare "fetch failed".
        var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "--use-system-ca helper/desktop.mjs") {
            WorkingDirectory = Path.Combine(root, "app"), UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        helper = new Process { StartInfo = start, EnableRaisingEvents = true };
        helper.OutputDataReceived += (s, e) => {
            if (e.Data == null) return;
            // Only a JSON object is a report. A blank line, 'null', an array or a number is something else
            // printed to stdout, and reading it as one either returns null or throws: drop the line instead.
            Dictionary<string, object> data;
            try { data = json.Deserialize<Dictionary<string, object>>(e.Data); } catch { return; }
            if (data == null) return;
            OnUi(() => {
                // Set here rather than on the reading thread, so it is written and read on the same one and a
                // report always lands before the exit that follows it.
                spoke = true;
                bool failed = data.ContainsKey("error");
                bool ended = failed || data.ContainsKey("stopped");
                // A running session can still hit something only the user can clear: an unwritable folder, a full
                // drive, a torrent given up on. The helper marks those, so they get the red dot a folder problem
                // already gets before pairing instead of the lime one that means everything is fine.
                bool problem = data.ContainsKey("problem");
                if (data.ContainsKey("status")) Say(Convert.ToString(data["status"]), failed || problem ? Skin.Alarm : ended || !running ? Skin.Muted : Skin.Lime);
                viewers = data.ContainsKey("peers") ? Convert.ToInt32(data["peers"]) : 0;
                // Whoever holds the pairing decides which torrent this machine downloads and seeds, so say who it
                // is for as long as the session lasts, not just in the moment the link is pasted.
                if (ended) site = "";
                else if (data.ContainsKey("site")) site = Convert.ToString(data["site"]);
                meta.Text = (site.Length > 0 ? "Paired with " + site + "     " : "") + (data.ContainsKey("peers") && data.ContainsKey("torrentPeers") ? "Viewers connected: " + data["peers"] + "     Torrent peers: " + data["torrentPeers"] : "");
                if (ended) SetRunning(false);
                if (failed && link.Text.Length == 0) link.Text = lastLink;
            });
        };
        // No console window or torrent identifiers in the interface. Crashes go to a capped local log.
        helper.ErrorDataReceived += (s, e) => { if (e.Data == null) return; try { string log = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CouchSwarm", "helper.log"); Directory.CreateDirectory(Path.GetDirectoryName(log)); if (File.Exists(log) && new FileInfo(log).Length > 262144) File.Delete(log); File.AppendAllText(log, DateTime.Now.ToString("s") + " " + e.Data + Environment.NewLine); } catch {} };
        helper.Exited += (s, e) => {
            int code = ((Process)s).ExitCode;
            OnUi(() => {
                if (quitting) { Close(); return; }
                // A helper that never reported anything did not get far enough for a pairing link to be the
                // problem: a partial extraction or a quarantined runtime dies here, and the only account of it
                // is the log this app keeps of its stderr.
                Say(spoke ? "Helper stopped (code " + code + "). Create a fresh pairing link to reconnect."
                    : "The helper could not start (code " + code + "). Details are in %LOCALAPPDATA%\\CouchSwarm\\helper.log.", Skin.Alarm);
                site = "";
                meta.Text = "";
                viewers = 0;
                SetRunning(false);
            });
        };
        try { helper.Start(); helper.BeginOutputReadLine(); helper.BeginErrorReadLine(); }
        catch { Say("Helper files are missing. Extract the whole ZIP, then open this app again.", Skin.Alarm); helper = null; }
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        // The title bar follows the High Contrast theme like every other window's.
        if (Skin.Contrast) return;
        // DWMWA_USE_IMMERSIVE_DARK_MODE. Windows builds without it keep the light title bar.
        try { int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int)); } catch {}
    }
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr flag, string text);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetDefaultDllDirectories(int flags);
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;
    [STAThread]
    static void Main() {
        // LOAD_LIBRARY_SEARCH_SYSTEM32: dwmapi.dll is not a KnownDLL, so keep it off the extraction folder.
        try { SetDefaultDllDirectories(0x800); } catch {}
        SetProcessDPIAware();
        bool first;
        using (var instance = new Mutex(true, "Local\\CouchSwarmHelper", out first)) {
            if (!first) { MessageBox.Show("CouchSwarm Helper is already running.", "CouchSwarm"); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new CouchSwarmHelper());
        }
    }
}
