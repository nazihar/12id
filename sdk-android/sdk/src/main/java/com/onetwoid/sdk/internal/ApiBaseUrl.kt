package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import java.net.URI

/**
 * The platform base URL must be https (review M14): the wallet token is a bearer credential on every
 * call, and Android blocks cleartext by default only from API 28, so on API 24–27 a typo would put the
 * token on the wire in clear. `http://` is accepted in a debuggable build, for a local platform-api.
 */
internal fun checkApiBaseUrl(apiBaseUrl: String, debuggable: Boolean) {
    val scheme = runCatching { URI(apiBaseUrl).scheme?.lowercase() }.getOrNull()
    if (scheme == "https") return
    if (scheme == "http" && debuggable) return
    val detail = if (scheme == "http") "apiBaseUrl '$apiBaseUrl' is not https; http is accepted only in a debuggable build"
    else "apiBaseUrl '$apiBaseUrl' must be an https URL"
    throw OneTwoIdException.InvalidConfiguration(detail)
}
