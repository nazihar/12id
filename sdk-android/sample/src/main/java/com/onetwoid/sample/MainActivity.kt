package com.onetwoid.sample

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.onetwoid.sdk.BiometricRequirement
import com.onetwoid.sdk.BiometricStatus
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialOffer
import com.onetwoid.sdk.ProofRequest
import com.onetwoid.sdk.ProofRequestOptions
import com.onetwoid.sdk.ProofSelection
import com.onetwoid.sdk.WalletState
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val viewModel: WalletViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { WalletScreen(viewModel) } }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { SampleCommands.verifyAll.collect { viewModel.verifyAllPending(this@MainActivity) } }
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refresh()
    }
}

@Composable
fun WalletScreen(viewModel: WalletViewModel) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var tab by remember { mutableIntStateOf(0) }

    LaunchedEffect(ui.message) {
        ui.message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            StatusBar(ui.state, onRetry = viewModel::retryInitialize)
            TabRow(selectedTabIndex = tab) {
                listOf("Connect", "Credentials (${ui.credentials.size})", "Offers (${ui.offers.size})", "Proofs (${ui.proofRequests.size})").forEachIndexed { i, title ->
                    Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) })
                }
            }
            when (tab) {
                0 -> ConnectTab(ui, viewModel)
                1 -> CredentialsTab(ui.credentials)
                2 -> OffersTab(ui.offers, viewModel)
                else -> ProofsTab(ui.proofRequests, ui.proofOptions, viewModel)
            }
        }
    }
}

@Composable
private fun StatusBar(state: WalletState, onRetry: () -> Unit) {
    val text = when (state) {
        WalletState.Uninitialized -> "Wallet: not initialised"
        WalletState.Initializing -> "Wallet: initialising…"
        WalletState.Ready -> "Wallet: ready"
        is WalletState.Failed -> "Wallet: failed (${state.error.javaClass.simpleName})"
    }
    Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(text, style = MaterialTheme.typography.titleMedium)
        if (state is WalletState.Failed) TextButton(onClick = onRetry) { Text("Retry") }
    }
}

@Composable
private fun ConnectTab(ui: WalletUi, viewModel: WalletViewModel) {
    var invitation by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> scanning = granted }

    if (scanning) {
        InvitationScanner(onResult = { url -> scanning = false; invitation = url; viewModel.connect(url) }, onCancel = { scanning = false })
        return
    }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(invitation, { invitation = it }, label = { Text("Invitation URL") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = ui.state is WalletState.Ready && invitation.isNotBlank(), onClick = { viewModel.connect(invitation) }) { Text("Connect") }
            OutlinedButton(enabled = ui.state is WalletState.Ready, onClick = {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                else cameraPermission.launch(Manifest.permission.CAMERA)
            }) { Text("Scan QR") }
            OutlinedButton(enabled = ui.state is WalletState.Ready, onClick = viewModel::sync) { Text("Sync") }
        }
        Spacer(Modifier.height(8.dp))
        Text("Connections", style = MaterialTheme.typography.titleSmall)
        ui.connections.forEach { Text("• ${it.label ?: "(no label)"} — ${it.status}") }
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = viewModel::reset) { Text("Reset wallet (credentials are lost)") }
    }
}

@Composable
private fun CredentialsTab(credentials: List<Credential>) {
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(credentials, key = { it.id }) { credential ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("${credential.schemaName} v${credential.schemaVersion}", style = MaterialTheme.typography.titleMedium)
                    credential.attributes.forEach { (k, v) -> Text("$k: $v") }
                    credential.expiresAtEpochSeconds?.let {
                        Text(if (credential.isExpired()) "Expired" else "Expires at epoch $it", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun OffersTab(offers: List<CredentialOffer>, viewModel: WalletViewModel) {
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(offers, key = { it.id }) { offer ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("From ${offer.connectionLabel ?: offer.connectionId}", style = MaterialTheme.typography.titleMedium)
                    offer.attributes.forEach { (k, v) -> Text("$k: $v") }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        offer.biometric?.let { BiometricNote(it) }
                        val activity = LocalContext.current as ComponentActivity
                        if (offer.biometric?.status == BiometricStatus.Pending) Button(onClick = { viewModel.verifyFace(activity, offer.id) }) { Text("Verify face") }
                        Button(onClick = { viewModel.acceptOffer(offer.id) }) { Text("Accept") }
                        OutlinedButton(onClick = { viewModel.declineOffer(offer.id) }) { Text("Decline") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProofsTab(requests: List<ProofRequest>, options: Map<String, ProofRequestOptions>, viewModel: WalletViewModel) {
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(requests, key = { it.id }) { request ->
            val option = options[request.id]
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("${request.name} from ${request.connectionLabel ?: request.connectionId}", style = MaterialTheme.typography.titleMedium)
                    request.attributeGroups.forEach { Text("Show: ${it.attributeNames.joinToString()}") }
                    request.predicates.forEach { Text("Prove: ${it.attributeName} ${it.operator} ${it.value}") }
                    val selection: ProofSelection? = option?.defaultSelection()
                    if (option != null && selection == null) Text("No matching credential", style = MaterialTheme.typography.labelMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        request.biometric?.let { BiometricNote(it) }
                        val activity = LocalContext.current as ComponentActivity
                        if (request.biometric?.status == BiometricStatus.Pending) Button(onClick = { viewModel.verifyFace(activity, request.id) }) { Text("Verify face") }
                        Button(enabled = selection != null, onClick = { selection?.let { viewModel.respondToProof(request.id, it) } }) { Text("Share") }
                        OutlinedButton(onClick = { viewModel.declineProof(request.id) }) { Text("Decline") }
                    }
                }
            }
        }
    }
}

/** Phase 6: shown on offers and proof requests that need a face check. */
@Composable
private fun BiometricNote(requirement: BiometricRequirement) {
    val text = when (requirement.status) {
        BiometricStatus.Pending -> "Face check required (${requirement.attemptsRemaining} attempts left)"
        BiometricStatus.Passed -> "Face check passed"
        else -> "Face check ${requirement.status.name.lowercase()}"
    }
    Text(text, style = MaterialTheme.typography.labelMedium)
}
