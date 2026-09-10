package com.rabi.link.recording

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One durable manifest per explicit recording session. Media remains in its original directory. */
class RecordingStore(private val context: Context) {
    data class Entry(val id: String, val kind: String, val source: String, val started: Long,
        val ended: Long, val state: String, val directory: File, val files: List<File>, val title: String)
    private val root = File(context.filesDir, "rabi-records").apply { mkdirs() }
    fun create(kind: String, source: String): Entry {
        val id = UUID.randomUUID().toString()
        val directory = if (kind == "video") File(context.filesDir, "rabi-live-recordings/sessions/$id") else File(root, "$id/media")
        check(directory.mkdirs() || directory.isDirectory)
        val data = JSONObject().put("id", id).put("kind", kind).put("source", source)
            .put("started", System.currentTimeMillis()).put("ended", 0).put("state", "recording")
            .put("directory", directory.relativeTo(context.filesDir).path)
        write(id, data)
        return read(File(root, "$id/session.json"))!!
    }
    @Synchronized fun finish(id: String, state: String) {
        val path = File(root, "$id/session.json")
        val data = JSONObject(AtomicFile(path).openRead().bufferedReader().use { it.readText() })
        data.put("ended", System.currentTimeMillis()).put("state", state)
        write(id, data)
    }
    private fun write(id: String, data: JSONObject) {
        val path = File(root, "$id/session.json"); path.parentFile!!.mkdirs()
        val atomic = AtomicFile(path); val output = atomic.startWrite()
        try { output.write(data.toString().toByteArray()); atomic.finishWrite(output) }
        catch (error: Exception) { atomic.failWrite(output); throw error }
    }
    private fun read(path: File): Entry? = runCatching {
        val data = JSONObject(AtomicFile(path).openRead().bufferedReader().use { it.readText() })
        val dir = File(context.filesDir, data.getString("directory")).canonicalFile
        check(dir.toPath().startsWith(context.filesDir.canonicalFile.toPath()))
        Entry(data.getString("id"), data.getString("kind"), data.getString("source"), data.getLong("started"),
            data.optLong("ended"), data.optString("state"), dir,
            dir.walkTopDown().filter { it.isFile && it.extension in listOf("mp4", "wav") }.sortedBy { it.name }.toList(), data.optString("title"))
    }.getOrNull()
    fun list(): List<Entry> {
        val sessions = root.listFiles().orEmpty().mapNotNull { read(File(it, "session.json")) }
        val oldRoot = File(context.filesDir, "rabi-live-recordings/rabi")
        val oldFiles = oldRoot.walkTopDown().filter { it.isFile && it.extension == "mp4" }.sortedBy { it.name }.toList()
        val legacy = if (oldFiles.isEmpty()) emptyList() else listOf(Entry("legacy-archive", "video", "glasses",
            oldFiles.maxOf { it.lastModified() }, oldFiles.maxOf { it.lastModified() }, "legacy", oldRoot, oldFiles, "历史视频"))
        return (sessions + legacy).sortedByDescending { it.started }
    }
}
