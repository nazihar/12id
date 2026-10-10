package com.onetwoid.reference

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The user's photo on file. An organisation that uses face checks already has one from its own
 * onboarding; this app stands in for that step by taking a photo at the first sign-in. It has
 * nothing to do with the 12id SDK: the photo goes to the app's backend, and the backend sends it to
 * 12id as the reference a later face check is compared with.
 */
object Photo {
    private fun file(context: Context) = File(context.cacheDir, "photo/photo.jpg").also { it.parentFile?.mkdirs() }

    /** Where the camera app writes the picture. */
    fun target(context: Context): Uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file(context))

    /**
     * The picture just taken as a JPEG of at most 1080 pixels on its long side, upright, about 100-300 KB:
     * enough for a face match and small enough to send. The full-size file is deleted.
     */
    fun taken(context: Context): ByteArray? {
        val file = file(context)
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            if (bounds.outWidth <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
            val decoded = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null

            // Cameras store the picture as the sensor saw it and note the rotation beside it.
            val degrees = when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
            val scale = MAX_SIDE.toFloat() / maxOf(decoded.width, decoded.height)
            val matrix = Matrix().apply {
                postRotate(degrees)
                if (scale < 1f) postScale(scale, scale)
            }
            val upright = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            return ByteArrayOutputStream().also { upright.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
        } finally {
            file.delete()
        }
    }

    /** The phone's camera app, asked to open on the front camera where it honours the hint. */
    class Capture : ActivityResultContracts.TakePicture() {
        override fun createIntent(context: Context, input: Uri): Intent = super.createIntent(context, input)
            .putExtra("android.intent.extras.CAMERA_FACING", 1)
            .putExtra("android.intent.extras.LENS_FACING_FRONT", 1)
            .putExtra("android.intent.extra.USE_FRONT_CAMERA", true)
    }

    private const val MAX_SIDE = 1080
}
