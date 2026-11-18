# Dibuja la primera página de un PDF en un PNG con el lector de PDF de Windows
# (Windows.Data.Pdf), sin programas adicionales, y escribe el número de páginas.
# Lo usa la vista previa de archivos (preview.js), que lo lanza con
# -EncodedCommand para no depender de la política de ejecución de scripts.
# Recibe los datos por variables de entorno:
#   CLAUDES_PDF        el PDF
#   CLAUDES_PNG        el PNG de salida
#   CLAUDES_PDF_WIDTH  ancho en píxeles (360 si no se indica)
$ErrorActionPreference = 'Stop'
$Pdf = $env:CLAUDES_PDF
$Png = $env:CLAUDES_PNG
$Width = 360
if ($env:CLAUDES_PDF_WIDTH) { $Width = [int]$env:CLAUDES_PDF_WIDTH }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]

$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asTaskOf = $extensions | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTaskAction = $extensions | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1

function Wait-Operation($operation, [Type]$type) {
  $task = $asTaskOf.MakeGenericMethod($type).Invoke($null, @($operation))
  [void]$task.Wait(15000)
  $task.Result
}
function Wait-Action($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  [void]$task.Wait(15000)
}

$file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
$doc = Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$page = $doc.GetPage(0)

$folder = Wait-Operation ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([System.IO.Path]::GetDirectoryName($Png))) ([Windows.Storage.StorageFolder])
$target = Wait-Operation ($folder.CreateFileAsync([System.IO.Path]::GetFileName($Png), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$stream = Wait-Operation ($target.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])

$options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$options.DestinationWidth = [uint32]$Width
Wait-Action ($page.RenderToStreamAsync($stream, $options))
$stream.Dispose()
$page.Dispose()
Write-Output $doc.PageCount
