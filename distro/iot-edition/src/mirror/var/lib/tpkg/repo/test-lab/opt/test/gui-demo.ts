import { Program, std, fs, shell } from "@tsix/Application";
import {
    Screen, div, button, h2, h3, paragraph,
    input, textarea, selectBox, span, image
} from "@tsix/emerald";
import { theme } from "@tsix/theme";

/**
 * GUI-DEMO v4 — Form + File Dialogs
 * Demo semua komponen Emerald: input, textarea, select, button, event handling,
 * openFileDialog & saveFileDialog
 */
export const appMode = "gui";

export const main = Program(async (args: string[]) => {
    await std.log("=== Emerald Form Demo v4 ===");
    await theme.loadCurrent();
    theme.watch();

    const app = new Screen({ title: "Emerald Form Demo", width: 900, height: 700 });

    // ================================================================
    // HELPER — buat form field (label + input)
    // ================================================================
    function formField(label: string, ...children: any[]) {
        return div({ style: { marginBottom: "14px" } },
            paragraph({ text: label, style: { margin: "0 0 4px 0", fontSize: "13px", color: "#aaa", fontWeight: "600" } }),
            ...children,
        );
    }


    // ================================================================
    // BUILD UI
    // Apply theme to window chrome
    const ps = await shell.ps();
    const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;
    if (domePid) await theme.applyToDome(domePid, app.wid);

    // ================================================================
    await app.mount(div({ id: "root", style: { padding: "18px", display: "flex", flexDirection: "column", gap: "12px", height: "100%", background: theme.colors.bg, color: theme.colors.text } },

        // HEADER
        div({ style: { marginBottom: "8px" } },
            h2({ text: "📋 Emerald Form Demo", style: { margin: "0 0 6px 0", fontSize: "20px", color: theme.colors.text } }),
            paragraph({ text: "Worker → GUI_REQ → Kernel → DOME → Browser", style: { color: theme.colors.textMuted, fontSize: "12px", margin: "0" } }),
        ),

        // MAIN AREA (two columns)
        div({ style: { display: "flex", gap: "20px", height: "100%", flex: "1", overflow: "hidden" } },

            // ---- KOLOM KIRI ----
            div({ style: { flex: "1", minWidth: "0", overflowY: "auto", paddingRight: "8px" } },

                // --- DATA DIRI ---
                h3({ text: "🧑 Data Diri", style: { color: theme.colors.accent, marginBottom: "12px", marginTop: "0" } }),

                formField("Nama Lengkap",
                    input({ id: "nama", type: "text", placeholder: "Masukkan nama lengkap...", style: { width: "100%" } }),
                ),
                formField("Email",
                    input({ id: "email", type: "text", placeholder: "email@contoh.com", style: { width: "100%" } }),
                ),
                formField("Bio Singkat",
                    textarea({ id: "bio", placeholder: "Ceritakan tentang dirimu...", rows: 3, style: { width: "100%" } }),
                ),

                // --- PREFERENSI ---
                h3({ text: "⚙️ Preferensi", style: { color: theme.colors.accent, marginBottom: "12px", marginTop: "20px" } }),

                formField("Bahasa",
                    selectBox({ id: "bahasa" }, [
                        { value: "id", text: "🇮🇩 Bahasa Indonesia" },
                        { value: "en", text: "🇬🇧 English" },
                        { value: "jp", text: "🇯🇵 日本語" },
                        { value: "su", text: "🫕 Basa Sunda" },
                    ]),
                ),
                formField("Tema Favorit",
                    div({ id: "tema-group", style: { display: "flex", gap: "8px" } },
                        button({ id: "tema-dark", text: "🌙 Dark", style: { background: "#333", color: "white", padding: "8px 14px", borderRadius: "6px", border: "2px solid #4caf50" } }),
                        button({ id: "tema-light", text: "☀️ Light", style: { background: "#444", color: "white", padding: "8px 14px", borderRadius: "6px" } }),
                        button({ id: "tema-hacker", text: "💻 Hacker", style: { background: "#444", color: "white", padding: "8px 14px", borderRadius: "6px" } }),
                    ),
                    span({ id: "tema-pick", text: "Dipilih: Dark", style: { display: "block", marginTop: "6px", fontSize: "12px", color: theme.colors.accent } }),
                ),

                // --- TOMBOL ---
                div({ id: "actions", style: { marginTop: "16px", display: "flex", gap: "10px" } },
                    button({ id: "btn-submit", text: "✅ Submit", style: { background: theme.colors.accent, color: "white", padding: "10px 20px", fontSize: "14px", borderRadius: "6px" } }),
                    button({ id: "btn-reset", text: "🔄 Reset", style: { background: theme.colors.danger, color: "white", padding: "10px 20px", fontSize: "14px", borderRadius: "6px" } }),
                ),

            ), // end kolom kiri

            // ---- KOLOM KANAN ----
            div({ style: { width: "320px", minWidth: "280px", display: "flex", flexDirection: "column", gap: "12px" } },

                // --- FILE DIALOG DEMO ---
                div({ style: { background: theme.colors.card, borderRadius: "8px", padding: "14px", border: "1px solid " + theme.colors.border } },
                    h3({ text: "📁 File Dialogs", style: { color: theme.colors.warning, margin: "0 0 10px 0", fontSize: "13px" } }),
                    button({ id: "btn-openfile", text: "📂 Open File...", style: { background: "#ff9800", color: "white", padding: "8px 12px", fontSize: "13px", marginBottom: "8px", width: "100%", borderRadius: "6px" } }),
                    span({ id: "openfile-result", text: "(belum dipilih)", style: { display: "block", fontSize: "12px", color: theme.colors.textDim, marginBottom: "10px", wordBreak: "break-all" } }),
                    button({ id: "btn-savefile", text: "💾 Save File...", style: { background: "#2196f3", color: "white", padding: "8px 12px", fontSize: "13px", marginBottom: "8px", width: "100%", borderRadius: "6px" } }),
                    span({ id: "savefile-result", text: "(belum disimpan)", style: { display: "block", fontSize: "12px", color: theme.colors.textDim, wordBreak: "break-all" } }),
                ),

                // --- IMAGE PREVIEW ---
                div({ style: { background: theme.colors.card, borderRadius: "8px", padding: "14px", border: "1px solid " + theme.colors.border } },
                    h3({ text: "🖼️ Image Preview", style: { color: theme.colors.warning, margin: "0 0 10px 0", fontSize: "13px" } }),
                    button({ id: "btn-loadimg", text: "📂 Load JPEG...", style: { background: "#9c27b0", color: "white", padding: "8px 12px", fontSize: "13px", marginBottom: "8px", width: "100%", borderRadius: "6px" } }),
                    div({ id: "img-container", style: { display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60px", background: theme.colors.bgAlt, borderRadius: "6px", padding: "8px", marginBottom: "8px" } },
                        image({ id: "img-preview", b64: "", alt: "Gambar", width: 200, height: 100 })
                    ),
                    span({ id: "img-status", text: "(klik Load untuk memilih file JPEG)", style: { display: "block", fontSize: "11px", color: theme.colors.textMuted, wordBreak: "break-all" } }),
                ),

                // --- QUESTION DEMO ---
                div({ style: { background: theme.colors.card, borderRadius: "8px", padding: "14px", border: "1px solid " + theme.colors.border } },
                    h3({ text: "❓ Question Dialog", style: { color: theme.colors.warning, margin: "0 0 10px 0", fontSize: "13px" } }),
                    button({ id: "btn-question", text: "✏️ Tanya Nama...", style: { background: "#e91e63", color: "white", padding: "8px 12px", fontSize: "13px", marginBottom: "8px", width: "100%", borderRadius: "6px" } }),
                    span({ id: "question-result", text: "(belum ditanya)", style: { display: "block", fontSize: "12px", color: theme.colors.textDim, wordBreak: "break-all" } }),
                ),

                // --- HASIL ---
                div({ id: "result-box", style: { padding: "14px", background: theme.colors.card, borderRadius: "8px", border: "1px solid " + theme.colors.border, flex: "1" } },
                    h3({ text: "📤 Hasil Submit", style: { color: theme.colors.accent, margin: "0 0 8px 0", fontSize: "13px" } }),
                    paragraph({ id: "result-text", text: "Silakan isi form & klik Submit.", style: { fontSize: "13px", lineHeight: "1.5", color: theme.colors.text } }),
                ),

            ), // end kolom kanan

        ), // end main area
    ));






    // ================================================================
    // STATE
    // ================================================================
    let tema = "Dark";
    let nama = "", email = "", bio = "", bahasa = "id";
    let openFilePath = "";
    let saveFilePath = "";
    let imgPath = "";
    let imgBase64 = "";
    let questionAnswer = "";

    // ================================================================
    // INPUT TRACKERS
    // ================================================================
    await app.on("nama", "input", (ev: any) => { if (ev.value !== undefined) nama = String(ev.value); });
    await app.on("email", "input", (ev: any) => { if (ev.value !== undefined) email = String(ev.value); });
    await app.on("bio", "input", (ev: any) => { if (ev.value !== undefined) bio = String(ev.value); });
    await app.on("bahasa", "input", (ev: any) => { if (ev.value !== undefined) bahasa = String(ev.value); });

    // ================================================================
    // TEMA
    // ================================================================
    async function setTema(t: string) {
        tema = t;
        const colors: Record<string, string> = { Dark: "#333", Light: "#333", Hacker: "#333" };
        colors[t] = "#4caf50";
        await app.update("tema-dark", { style: { background: colors["Dark"], color: "white", padding: "6px 14px", border: "2px solid " + (t === "Dark" ? "#4caf50" : "#555") } });
        await app.update("tema-light", { style: { background: colors["Light"], color: "white", padding: "6px 14px", border: "2px solid " + (t === "Light" ? "#4caf50" : "#555") } });
        await app.update("tema-hacker", { style: { background: colors["Hacker"], color: "white", padding: "6px 14px", border: "2px solid " + (t === "Hacker" ? "#4caf50" : "#555") } });
        await app.update("tema-pick", { text: "Dipilih: " + t });
    }

    await app.on("tema-dark", "click", () => setTema("Dark"));
    await app.on("tema-light", "click", () => setTema("Light"));
    await app.on("tema-hacker", "click", () => setTema("Hacker"));


    app.update("nama", { value: "John Doe" });
    app.update("bahasa", { value: "su" });

    // ================================================================
    // FILE DIALOGS
    // ================================================================
    await app.on("btn-loadimg", "click", async () => {
        const file = await app.openFileDialog(fs, {
            title: "📂 Pilih File Gambar",
            startDir: await shell.getenv("HOME") || "/mnt/shared",
            filter: [".jpg", ".jpeg", ".png"],
        });
        if (file?.path)
            await app.updateImageFromFile(fs, "img-preview", file?.path || "");
    });

    // --- Question dialog ---
    await app.on("btn-question", "click", async () => {
        const answer = await app.question("❓ Pertanyaan", "Siapa nama kamu?");
        if (answer !== null) {
            questionAnswer = answer;
            await app.update("question-result", { text: "Jawaban: " + answer, style: { color: "#4caf50" } });
        }
    });

    // --- Open File ---
    await app.on("btn-openfile", "click", async () => {
        const file = await app.openFileDialog(fs, {
            title: "📂 Buka File",
            startDir: "/",
            filter: [".ts", ".js", ".json", ".txt", ".md"],
        });
        if (file) {
            openFilePath = file.path;
            await app.update("openfile-result", {
                text: "📄 " + file.filename + " (di " + file.directory + ")",
                style: { fontSize: "12px", color: "#4caf50" },
            });
            await std.log("Open file: " + file.path);
            // Baca & tampilkan isi file
            try {
                const fd = await fs.open(file.path);
                const content = await fs.read(fd);
                await fs.close(fd);
                const preview = String(content).substring(0, 200);
                await app.alert("📄 Preview: " + file.filename, preview + (String(content).length > 200 ? "..." : ""));
            } catch (e: any) {
                await app.alert("⚠️ Error", "Gagal membaca file: " + e.message);
            }
        } else {
            await app.update("openfile-result", { text: "(dibatalkan)", style: { fontSize: "12px", color: "#888" } });
        }
    });

    // --- Save File ---
    await app.on("btn-savefile", "click", async () => {
        const file = await app.saveFileDialog(fs, {
            title: "💾 Simpan File",
            startDir: "/tmp",
            defaultName: "output.txt",
        });
        if (file) {
            saveFilePath = file.path;
            await app.update("savefile-result", {
                text: "💾 " + file.filename + " (di " + file.directory + ")",
                style: { fontSize: "12px", color: "#2196f3" },
            });
            await std.log("Save file: " + file.path);
            // Tulis data dummy
            try {
                const ts = new Date().toISOString();
                const content = `# TSIX Save Demo\n\nTimestamp: ${ts}\nNama: ${nama || "N/A"}\nBahasa: ${bahasa}\n`;
                await fs.writeFile(file.path, content);
                await app.alert("✅ Tersimpan!", "File berhasil disimpan:\n" + file.path + "\n\nUkuran: " + content.length + " bytes");
            } catch (e: any) {
                await app.alert("⚠️ Error", "Gagal menyimpan file: " + e.message);
            }
        } else {
            await app.update("savefile-result", { text: "(dibatalkan)", style: { fontSize: "12px", color: "#888" } });
        }
    });

    // ================================================================
    // SUBMIT & RESET
    // ================================================================
    await app.on("btn-submit", "click", async () => {
        await std.println("");
        await std.println("═══════════════════════════════════");
        await std.println("  📤 FORM SUBMITTED");
        await std.println("═══════════════════════════════════");
        await std.println("  Nama      : " + (nama || "(kosong)"));
        await std.println("  Email     : " + (email || "(kosong)"));
        await std.println("  Bio       : " + (bio || "(kosong)"));
        await std.println("  Bahasa    : " + bahasa);
        await std.println("  Tema      : " + tema);
        await std.println("  Open File : " + (openFilePath || "(none)"));
        await std.println("  Save File : " + (saveFilePath || "(none)"));
        await std.println("═══════════════════════════════════");
        await std.println("");

        await app.update("result-text", {
            innerHTML:
                "<strong>✅ Form Disubmit!</strong><br><br>" +
                "<b>Nama:</b> " + (nama || "<i>(kosong)</i>") + "<br>" +
                "<b>Email:</b> " + (email || "<i>(kosong)</i>") + "<br>" +
                "<b>Bio:</b> " + (bio || "<i>(kosong)</i>") + "<br>" +
                "<b>Bahasa:</b> " + bahasa + "<br>" +
                "<b>Tema:</b> " + tema + "<br>" +
                "<b>Open File:</b> " + (openFilePath ? "<span style='color:#4caf50'>" + openFilePath.split("/").pop() + "</span>" : "<i>(none)</i>") + "<br>" +
                "<b>Save File:</b> " + (saveFilePath ? "<span style='color:#2196f3'>" + saveFilePath.split("/").pop() + "</span>" : "<i>(none)</i>") + "<br><br>" +
                "<span style='color:#888;font-size:11px'>Data juga dicetak di CLI!</span>",
        });

        await app.alert("Form Terkirim!", `Hai ${nama || "User"}, data kamu sudah tersimpan.`);
    });

    await app.on("btn-reset", "click", async () => {
        const ans = await app.confirm("Reset Form?", "Semua data yang sudah diisi akan hilang.", ["Yes", "No"]);
        if (ans !== "Yes") return;
        openFilePath = "";
        saveFilePath = "";
        await app.update("result-text", { text: "Silakan isi form & klik Submit." });
        await app.update("openfile-result", { text: "(belum dipilih)", style: { fontSize: "12px", color: "#aaa" } });
        await app.update("savefile-result", { text: "(belum disimpan)", style: { fontSize: "12px", color: "#aaa" } });
        await setTema("Dark");
    });

    // ================================================================
    // GO!
    // ================================================================
    await std.log("Open http://localhost:8080 — try the file dialogs!");

    await app.loopUntilClose();
    await std.log("Goodbye!");
});


