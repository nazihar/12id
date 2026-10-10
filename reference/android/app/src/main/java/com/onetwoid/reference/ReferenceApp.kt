package com.onetwoid.reference

import android.app.Application

class ReferenceApp : Application() {
    lateinit var backend: Backend
        private set
    lateinit var wallet: Wallet
        private set

    override fun onCreate() {
        super.onCreate()
        backend = Backend(this, BuildConfig.BACKEND_URL)
        wallet = Wallet(this, backend)
    }
}
