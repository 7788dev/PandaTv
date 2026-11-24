package app.panda.tv.playback

import org.junit.Assert.*
import org.junit.Test
import java.io.InterruptedIOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SharedSegmentFlowTest {
    private fun awaitWaiting(thread: Thread) {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (thread.state != Thread.State.WAITING && System.nanoTime() < until) Thread.yield()
        assertEquals("Reader did not reach the waiting state", Thread.State.WAITING, thread.state)
    }
    @Test fun `closing a reader wakes its blocked read while a different reader can continue`() {
        val flow = SharedSegmentFlow("video/mp2t", 4) {}
        val closing = flow.openReader()
        val continuing = flow.openReader()
        lateinit var thread: Thread
        val executor = Executors.newSingleThreadExecutor { work -> Thread(work, "closing-reader").also { thread = it } }
        val began = CountDownLatch(1)
        try {
            val result = executor.submit<Int> { began.countDown(); closing.read(ByteArray(4), 0, 4) }
            assertTrue(began.await(2, TimeUnit.SECONDS)); awaitWaiting(thread)
            closing.close()
            assertEquals(-1, result.get(1, TimeUnit.SECONDS).toInt())
            assertTrue(flow.write(byteArrayOf(1, 2, 3, 4)))
            val data = ByteArray(4)
            assertEquals(4, continuing.read(data, 0, 4))
            assertArrayEquals(byteArrayOf(1, 2, 3, 4), data)
            flow.end()
            assertEquals(-1, continuing.read(data, 0, 4))
        } finally { closing.close(); continuing.close(); flow.fail(); executor.shutdownNow() }
    }
    @Test fun `closing after a prefix also wakes a reader waiting for more bytes`() {
        val flow = SharedSegmentFlow("video/mp2t", 100) {}
        val reader = flow.openReader()
        flow.write(byteArrayOf(1, 2))
        assertEquals(2, reader.read(ByteArray(4), 0, 4))
        lateinit var thread: Thread
        val executor = Executors.newSingleThreadExecutor { work -> Thread(work).also { thread = it } }
        val began = CountDownLatch(1)
        try {
            val result = executor.submit<Int> { began.countDown(); reader.read(ByteArray(4), 0, 4) }
            assertTrue(began.await(2, TimeUnit.SECONDS)); awaitWaiting(thread)
            reader.close()
            assertEquals(-1, result.get(1, TimeUnit.SECONDS).toInt())
        } finally { reader.close(); flow.fail(); executor.shutdownNow() }
    }
    @Test fun `interruption reports an IO cancellation and preserves the interrupt flag`() {
        val flow = SharedSegmentFlow("video/mp2t", 100) {}
        val reader = flow.openReader()
        lateinit var thread: Thread
        val executor = Executors.newSingleThreadExecutor { work -> Thread(work).also { thread = it } }
        val began = CountDownLatch(1)
        try {
            val result = executor.submit<Boolean> {
                began.countDown()
                try { reader.read(ByteArray(4), 0, 4); false }
                catch (error: InterruptedIOException) { error.cause is InterruptedException && Thread.currentThread().isInterrupted }
            }
            assertTrue(began.await(2, TimeUnit.SECONDS)); awaitWaiting(thread)
            thread.interrupt()
            assertTrue(result.get(1, TimeUnit.SECONDS))
        } finally { reader.close(); flow.fail(); executor.shutdownNow() }
    }
    @Test fun `a reader attaching after completion receives the completed warm bytes`() {
        val flow = SharedSegmentFlow("video/mp2t", 4) {}
        flow.write(byteArrayOf(1, 2, 3, 4)); flow.end()
        val reader = flow.openReader()
        val data = ByteArray(4)
        assertEquals(4, reader.read(data, 0, 4))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), data)
        reader.close()
    }
}
