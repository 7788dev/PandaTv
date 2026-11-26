package app.panda.tv.storage

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

internal fun writeAtomic(target: File, bytes: ByteArray) {
    val parent = target.parentFile ?: throw IOException("Missing state directory")
    if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create state directory")
    val tmp = File(parent, "${target.name}.${UUID.randomUUID()}.tmp")
    val rollback = File(parent, "${target.name}.${UUID.randomUUID()}.rollback")
    try {
        FileOutputStream(tmp).use { output -> output.write(bytes); output.fd.sync() }
        if (tmp.renameTo(target)) return
        // Windows cannot rename over an existing file. Never fall back to truncating it.
        if (!target.isFile || !target.renameTo(rollback)) throw IOException("Cannot replace state file")
        if (!tmp.renameTo(target)) {
            if (!rollback.renameTo(target)) throw IOException("Cannot restore state file")
            throw IOException("Cannot commit state file")
        }
    } finally {
        tmp.delete()
        if (target.isFile) rollback.delete()
    }
}
