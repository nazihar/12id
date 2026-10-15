package com.onetwoid.reference

import android.content.Context
import androidx.compose.ui.graphics.Color

/**
 * Everything that makes the app look like one organisation's app. The wallet code (Wallet.kt) and the
 * backend calls (Backend.kt) are the same for every skin; a new client is a new entry in [Skins].
 */
data class Skin(
    val id: String,
    /** The name in the skin chooser at first launch. */
    val name: String,
    /** Which set of screens draws it: the standard ones (MainActivity.kt), or a client's own look. */
    val style: SkinStyle,
    val organisation: String,
    val tagline: String,
    val primary: Color,
    val onPrimary: Color,
    /** What the credential is called in this app. */
    val cardTitle: String,
    /** Credential attribute → the label shown on the card, in this order. Attributes not listed are not shown. */
    val attributeLabels: Map<String, String>,
    val action: ActionSkin,
)

enum class SkinStyle {
    /** The plain screens in MainActivity.kt, coloured by the skin. */
    Standard,

    /** A copy of MTB's own app, MTB Neo (MtbNeo.kt). */
    MtbNeo,
}

/** The one thing the user does that needs their proof. `type` is the action's name in the backend's tenant.json. */
data class ActionSkin(
    val type: String,
    val button: String,
    val title: String,
    val fields: List<ActionField>,
    val confirm: String,
    val approved: String,
    val declined: String,
)

data class ActionField(val key: String, val label: String, val numeric: Boolean = false)

object Skins {
    val default = Skin(
        id = "default",
        name = "12iD reference",
        style = SkinStyle.Standard,
        organisation = "Acme Bank",
        tagline = "Approve with your phone, not with a code",
        primary = Color(0xFF1F3A5F),
        onPrimary = Color.White,
        cardTitle = "Verified customer",
        attributeLabels = linkedMapOf("fullName" to "Name", "memberId" to "Customer ID", "level" to "KYC level"),
        action = ActionSkin(
            type = "transfer",
            button = "Send money",
            title = "Send money",
            fields = listOf(ActionField("amount", "Amount (BDT)", numeric = true), ActionField("payee", "To")),
            confirm = "Approve transfer",
            approved = "Transfer approved",
            declined = "Transfer not approved",
        ),
    )

    val mtbNeo = Skin(
        id = "mtb-neo",
        name = "MTB Neo",
        style = SkinStyle.MtbNeo,
        organisation = "MTB",
        tagline = "MTB Neo",
        primary = Color(0xFF0A8A78),
        onPrimary = Color.White,
        cardTitle = "MTB Neo verified customer",
        attributeLabels = linkedMapOf("fullName" to "Name", "memberId" to "Customer ID", "level" to "KYC level"),
        action = ActionSkin(
            type = "transfer",
            button = "MTB Transfer",
            title = "MTB Transfer",
            fields = listOf(ActionField("payee", "Beneficiary account", numeric = true), ActionField("amount", "Amount (BDT)", numeric = true)),
            confirm = "Approve transfer",
            approved = "Transfer approved",
            declined = "Transfer not approved",
        ),
    )

    val all = listOf(default, mtbNeo)

    /**
     * The skin is chosen once, at the first launch, and kept: a client who is shown the demo never sees
     * the other skins. It has its own preferences file, so "Reset this app" (Backend.forget) keeps it;
     * only clearing the app's data or reinstalling asks again.
     */
    fun chosen(context: Context): Skin? =
        prefs(context).getString("skin", null)?.let { id -> all.firstOrNull { it.id == id } }

    fun choose(context: Context, skin: Skin) {
        prefs(context).edit().putString("skin", skin.id).commit()
    }

    private fun prefs(context: Context) = context.getSharedPreferences("skin", Context.MODE_PRIVATE)
}
