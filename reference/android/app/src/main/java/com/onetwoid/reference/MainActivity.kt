package com.onetwoid.reference

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.onetwoid.sdk.BiometricStatus
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialOffer
import com.onetwoid.sdk.ProofRequest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** The screens. Nothing here knows about 12id beyond the three SDK models it displays. */
class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val skin = Skins.current
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = skin.primary, onPrimary = skin.onPrimary)) {
                Surface(Modifier.fillMaxSize().safeDrawingPadding()) { App(viewModel, skin) }
            }
        }
    }
}

@Composable
private fun App(viewModel: MainViewModel, skin: Skin) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        Header(skin)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            when (val screen = ui.screen) {
                Screen.SignIn -> SignIn(skin, ui.busy, viewModel::signIn)
                is Screen.Working -> Progress(screen.message)
                Screen.Photo -> PhotoStep(skin, ui.busy, viewModel::submitPhoto)
                Screen.Home -> Home(skin, ui, viewModel)
                Screen.ActionForm -> ActionForm(skin, ui.busy, viewModel::startAction, viewModel::backHome)
                is Screen.ActionWaiting -> {
                    Details(skin, screen.details)
                    Progress(screen.message)
                    TextButton(onClick = viewModel::backHome) { Text("Cancel") }
                }
                is Screen.ActionDone -> ActionDone(skin, screen, viewModel::backHome)
            }
        }
    }

    val activity = LocalContext.current as ComponentActivity
    ui.offer?.let { OfferDialog(skin, it, ui, onAccept = { viewModel.acceptOffer(activity) }, onDecline = viewModel::declineOffer) }
    val waiting = ui.screen as? Screen.ActionWaiting
    if (waiting != null) ui.request?.let { ApprovalDialog(skin, waiting.details, it, ui, onApprove = { viewModel.approveRequest(activity) }, onDecline = viewModel::declineRequest) }
    BackHandler(enabled = ui.screen is Screen.ActionForm || ui.screen is Screen.ActionDone, onBack = viewModel::backHome)
}

@Composable
private fun Header(skin: Skin) {
    Surface(color = skin.primary, contentColor = skin.onPrimary, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 16.dp)) {
            Text(skin.organisation, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(skin.tagline, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SignIn(skin: Skin, busy: Boolean, onSignIn: (String, String) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    Text("Sign in", style = MaterialTheme.typography.headlineSmall)
    OutlinedTextField(name, { name = it }, label = { Text("Your name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(code, { code = it }, label = { Text("Access code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Button(enabled = !busy && name.isNotBlank() && code.isNotBlank(), onClick = { onSignIn(name, code) }, modifier = Modifier.fillMaxWidth()) {
        Text("Sign in to ${skin.organisation}")
    }
}

/**
 * First sign-in at an organisation that uses face checks: it needs a photo of the user to compare a
 * live face with. A real organisation has it from its own onboarding; here the user takes it now.
 */
@Composable
private fun PhotoStep(skin: Skin, busy: Boolean, onPhoto: (ByteArray) -> Unit) {
    val context = LocalContext.current
    var problem by remember { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(Photo.Capture()) { taken ->
        val photo = if (taken) Photo.taken(context) else null
        if (photo != null) onPhoto(photo) else problem = "No photo was taken."
    }
    // The face-check add-on declares the camera permission, so Android wants it granted before any camera use.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) camera.launch(Photo.target(context)) else problem = "The camera is needed to take your photo."
    }
    Text("Your photo", style = MaterialTheme.typography.headlineSmall)
    Text("${skin.organisation} keeps a photo of each customer. Before important steps it checks that the person holding this phone is you, by comparing your face with that photo.")
    Text("Take a clear photo of your face, looking at the camera.")
    problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    Button(enabled = !busy, onClick = { problem = null; permission.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth()) { Text("Take my photo") }
}

@Composable
private fun Progress(message: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.height(24.dp))
        Text(message)
    }
}

@Composable
private fun Home(skin: Skin, ui: Ui, viewModel: MainViewModel) {
    var confirmReset by remember { mutableStateOf(false) }
    ui.user?.let { Text("Hello, ${it.name}", style = MaterialTheme.typography.headlineSmall) }
    val card = ui.card
    if (card != null) {
        CardView(skin, card)
        Button(enabled = !ui.busy, onClick = viewModel::openActionForm, modifier = Modifier.fillMaxWidth()) { Text(skin.action.button) }
    } else {
        Text("You do not have your ${skin.cardTitle} card yet.")
        Button(enabled = !ui.busy, onClick = { viewModel.setUp() }, modifier = Modifier.fillMaxWidth()) { Text("Get my card") }
    }
    Spacer(Modifier.height(24.dp))
    TextButton(onClick = { confirmReset = true }) { Text("Reset this app") }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Reset this app?") },
            text = { Text("Your card is deleted from this phone and you are signed out. ${skin.organisation} gives you a new card when you sign in again.") },
            confirmButton = { Button(onClick = { confirmReset = false; viewModel.reset() }) { Text("Reset") } },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Keep") } },
        )
    }
}

@Composable
private fun CardView(skin: Skin, card: Credential) {
    Card(colors = CardDefaults.cardColors(containerColor = skin.primary, contentColor = skin.onPrimary), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(skin.organisation, style = MaterialTheme.typography.labelLarge)
            Text(skin.cardTitle, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            Attributes(skin, card.attributes)
            card.expiresAtEpochSeconds?.let { Text(if (card.isExpired()) "Expired" else "Valid until ${formatDate(it)}", style = MaterialTheme.typography.labelMedium) }
        }
    }
}

/** The attributes the skin names, with its labels, in its order. */
@Composable
private fun Attributes(skin: Skin, attributes: Map<String, String>) {
    skin.attributeLabels.forEach { (name, label) ->
        attributes[name]?.let { Text("$label: $it") }
    }
}

@Composable
private fun ActionForm(skin: Skin, busy: Boolean, onStart: (Map<String, String>) -> Unit, onBack: () -> Unit) {
    val values = remember { mutableStateMapOf<String, String>() }
    Text(skin.action.title, style = MaterialTheme.typography.headlineSmall)
    skin.action.fields.forEach { field ->
        OutlinedTextField(
            value = values[field.key].orEmpty(),
            onValueChange = { values[field.key] = it },
            label = { Text(field.label) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = if (field.numeric) KeyboardType.Number else KeyboardType.Text),
            modifier = Modifier.fillMaxWidth(),
        )
    }
    Button(enabled = !busy && skin.action.fields.all { !values[it.key].isNullOrBlank() }, onClick = { onStart(values.toMap()) }, modifier = Modifier.fillMaxWidth()) {
        Text("Continue")
    }
    TextButton(onClick = onBack) { Text("Back") }
}

@Composable
private fun Details(skin: Skin, details: Map<String, String>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        skin.action.fields.forEach { field -> details[field.key]?.let { Text("${field.label}: $it", style = MaterialTheme.typography.titleMedium) } }
    }
}

@Composable
private fun ActionDone(skin: Skin, screen: Screen.ActionDone, onBack: () -> Unit) {
    Text(if (screen.approved) skin.action.approved else skin.action.declined, style = MaterialTheme.typography.headlineSmall)
    Details(skin, screen.details)
    if (screen.approved && screen.shared.isNotEmpty()) {
        Text("${skin.organisation} received:", style = MaterialTheme.typography.labelLarge)
        screen.shared.forEach { (name, value) -> Text("${skin.attributeLabels[name] ?: name}: $value") }
    }
    Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Done") }
}

@Composable
private fun OfferDialog(skin: Skin, offer: CredentialOffer, ui: Ui, onAccept: () -> Unit, onDecline: () -> Unit) {
    val faceCheck = offer.biometric?.status == BiometricStatus.Pending
    AlertDialog(
        onDismissRequest = {},
        title = { Text("Your ${skin.cardTitle} card") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${skin.organisation} wants to add this card to your phone:")
                Attributes(skin, offer.attributes)
                if (faceCheck) FaceCheckNote(skin, offer.biometric?.attemptsRemaining)
                ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { Button(enabled = !ui.busy, onClick = onAccept) { Text(if (faceCheck) "Check my face" else "Add card") } },
        dismissButton = { OutlinedButton(enabled = !ui.busy, onClick = onDecline) { Text("Not now") } },
    )
}

@Composable
private fun FaceCheckNote(skin: Skin, attemptsRemaining: Int?) {
    Text(
        "${skin.organisation} first checks that it is you: you look at the camera for a few seconds." + (attemptsRemaining?.let { " Attempts left: $it." } ?: ""),
        style = MaterialTheme.typography.bodySmall,
    )
}

/** What the user approves: the action's details, what is shared, and what is proven without being shown. */
@Composable
private fun ApprovalDialog(skin: Skin, details: Map<String, String>, request: ProofRequest, ui: Ui, onApprove: () -> Unit, onDecline: () -> Unit) {
    val faceCheck = request.biometric?.status == BiometricStatus.Pending
    val shared = request.attributeGroups.flatMap { it.attributeNames }.map { skin.attributeLabels[it] ?: it }
    val proven = request.predicates.map { predicate ->
        if (predicate.attributeName == "expiresOn") "your card is still valid"
        else "${skin.attributeLabels[predicate.attributeName] ?: predicate.attributeName} ${predicate.operator} ${predicate.value}"
    }
    AlertDialog(
        onDismissRequest = {},
        title = { Text(skin.action.confirm) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Details(skin, details)
                if (shared.isNotEmpty()) Text("${skin.organisation} will see: ${shared.joinToString()}.")
                if (proven.isNotEmpty()) Text("Proven without being shown: ${proven.joinToString()}.")
                if (faceCheck) FaceCheckNote(skin, request.biometric?.attemptsRemaining)
                ui.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { Button(enabled = !ui.busy, onClick = onApprove) { Text(if (faceCheck) "Check my face and approve" else "Approve") } },
        dismissButton = { OutlinedButton(enabled = !ui.busy, onClick = onDecline) { Text("Decline") } },
    )
}

private fun formatDate(epochSeconds: Long): String =
    SimpleDateFormat("d MMM yyyy", Locale.getDefault()).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(epochSeconds * 1000))
