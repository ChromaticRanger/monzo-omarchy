import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Monzo bar widget: bank icon + popup with balances, pots and the last 7 days
// of transactions. All API work happens in the `monzo-omarchy` CLI, which
// writes snapshot.json; this file only renders that file and asks the CLI to
// refresh when the panel opens. No credentials ever pass through QML.
Panel {
  id: root
  moduleName: "chromaticranger.monzo"
  ipcTarget: "chromaticranger.monzo"
  manageIpc: false

  readonly property string home: Quickshell.env("HOME")
  // The CLI ships inside the plugin folder, so `omarchy plugin add` is a
  // complete install. Run via bash so a lost executable bit can't break it.
  // Omarchy always installs third-party plugins at ~/.config/omarchy/plugins/<id>/.
  readonly property string cli: home + "/.config/omarchy/plugins/" + moduleName + "/bin/monzo-omarchy"
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")) + "/monzo-omarchy"

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property var snapshot: Model.parseSnapshot("")
  property var now: new Date()
  readonly property bool refreshing: refreshProc.running
  readonly property bool needsLogin: snapshot.status === "needs_login" || snapshot.status === "missing"
  readonly property bool hasError: snapshot.status === "error"
  readonly property var days: Model.groupByDay(snapshot.transactions, now)

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function refresh() {
    root.now = new Date()
    if (!refreshProc.running) refreshProc.running = true
  }

  function login() {
    // The launcher takes one shell command string, so quote twice.
    if (root.bar) root.bar.run("omarchy-launch-floating-terminal-with-presentation "
      + root.bar.shellQuote("bash " + root.bar.shellQuote(root.cli) + " login"))
    root.close()
  }

  function scrollBy(dy) {
    var maxY = Math.max(0, flick.contentHeight - flick.height)
    flick.contentY = Math.max(0, Math.min(maxY, flick.contentY + dy))
  }

  onOpenedChanged: if (opened) {
    flick.contentY = 0
    root.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  property FileView snapshotFile: FileView {
    path: root.stateDir + "/snapshot.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.snapshot = Model.parseSnapshot(text())
    onLoadFailed: root.snapshot = Model.parseSnapshot("")
  }

  property Process refreshProc: Process {
    command: ["bash", root.cli, "refresh"]
    // The FileView watch normally catches the rewrite; reload anyway so a
    // first-ever snapshot (file did not exist when watched) is picked up.
    onExited: function(exitCode) { root.snapshotFile.reload() }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰁰"   // nf-md-bank
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { root.scrollBy(dy * Style.space(48)) }
      onActivateRequested: if (root.needsLogin) root.login()
      onTextKey: function(t) { if (t === "r" || t === "R") root.refresh() }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: column
          width: flick.width
          spacing: Style.space(10)

          // ---- Header: title, last-updated, refresh.
          Item {
            width: parent.width
            height: Math.max(title.implicitHeight, refreshButton.implicitHeight)

            PanelSectionHeader {
              id: title
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "MONZO"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Row {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.spacing.md

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.refreshing ? "Refreshing…" : Model.updatedLabel(root.snapshot.updatedAt, root.now)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              PanelActionButton {
                id: refreshButton
                iconText: "󰑐"   // nf-md-refresh
                tooltipText: "Refresh (r)"
                foreground: root.foreground
                fontFamily: root.fontFamily
                enabled: !root.refreshing
                onClicked: root.refresh()
              }
            }
          }

          // ---- Login / error banner.
          Rectangle {
            visible: root.needsLogin || root.hasError
            width: parent.width
            height: banner.implicitHeight + Style.space(16)
            radius: Style.cornerRadius
            color: Qt.rgba(root.urgent.r, root.urgent.g, root.urgent.b, 0.12)

            Column {
              id: banner
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.margins: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: root.needsLogin ? "Not logged in to Monzo." : "Couldn't refresh. Showing the last data received."
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              Text {
                visible: text !== ""
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: root.snapshot.error
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                visible: root.needsLogin
                textFormat: Text.PlainText
                text: "Log in (Enter)"
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.underline: true
                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.login()
                }
              }
            }
          }

          // ---- Accounts.
          Repeater {
            model: root.snapshot.accounts

            Column {
              required property var modelData
              width: column.width
              spacing: Style.space(2)

              Item {
                width: parent.width
                height: Math.max(accountLabel.implicitHeight, accountAmount.implicitHeight)

                Text {
                  id: accountLabel
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: modelData.label
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                }
                Text {
                  id: accountAmount
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: modelData.available ? Model.accountAmount(modelData) : modelData.note
                  color: modelData.available ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: modelData.available ? Style.font.heading : Style.font.bodySmall
                  font.bold: modelData.available && modelData.kind === "personal"
                  font.italic: !modelData.available
                }
              }

              Text {
                visible: modelData.kind === "personal" && modelData.spendToday !== null && modelData.spendToday !== undefined
                textFormat: Text.PlainText
                text: "Spent today " + Model.money(Math.abs(Number(modelData.spendToday) || 0), modelData.currency)
                  + (modelData.totalBalance !== null && modelData.totalBalance !== undefined
                     ? "  ·  with pots " + Model.money(modelData.totalBalance, modelData.currency) : "")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          // ---- Pots.
          PanelSectionHeader {
            visible: root.snapshot.pots.length > 0
            text: "POTS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Repeater {
            model: root.snapshot.pots

            Item {
              required property var modelData
              width: column.width
              height: Math.max(potName.implicitHeight, potAmount.implicitHeight)

              Text {
                id: potName
                anchors.left: parent.left
                anchors.leftMargin: Style.space(12)
                anchors.right: potAmount.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: modelData.name
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              Text {
                id: potAmount
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: Model.money(modelData.balance, modelData.currency)
                  + (modelData.goal ? " / " + Model.money(modelData.goal, modelData.currency) : "")
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }

          PanelSeparator {
            visible: root.snapshot.accounts.length > 0
            foreground: root.foreground
          }

          // ---- Transactions, grouped by day.
          PanelSectionHeader {
            visible: root.snapshot.accounts.length > 0
            text: "LAST " + root.snapshot.sinceDays + " DAYS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            visible: root.snapshot.status === "ok" && root.snapshot.transactions.length === 0
            textFormat: Text.PlainText
            text: "No transactions."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.italic: true
          }

          Repeater {
            model: root.days

            Column {
              id: dayColumn
              required property var modelData
              width: column.width
              spacing: Style.space(4)

              Item {
                width: parent.width
                height: dayHeader.implicitHeight

                Text {
                  id: dayHeader
                  anchors.left: parent.left
                  textFormat: Text.PlainText
                  text: dayColumn.modelData.label
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: dayHeader.verticalCenter
                  visible: dayColumn.modelData.spent < 0
                  textFormat: Text.PlainText
                  text: Model.money(dayColumn.modelData.spent, "GBP")
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              Repeater {
                model: dayColumn.modelData.items

                Item {
                  id: txRow
                  required property var modelData
                  width: dayColumn.width
                  height: Math.max(Style.space(22), txName.implicitHeight + Style.space(4))
                  opacity: modelData.declined ? 0.5 : 1

                  Text {
                    id: txEmoji
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(22)
                    horizontalAlignment: Text.AlignHCenter
                    textFormat: Text.PlainText
                    text: txRow.modelData.emoji
                    font.pixelSize: Style.font.subtitle
                  }
                  Text {
                    id: txTime
                    anchors.left: txEmoji.right
                    anchors.leftMargin: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: Model.timeLabel(txRow.modelData.created)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    id: txName
                    anchors.left: txTime.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: txTags.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: txRow.modelData.name
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.strikeout: txRow.modelData.declined
                  }
                  Row {
                    id: txTags
                    anchors.right: txAmount.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(4)

                    Text {
                      visible: txRow.modelData.pending && !txRow.modelData.declined
                      anchors.verticalCenter: parent.verticalCenter
                      textFormat: Text.PlainText
                      text: "pending"
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.italic: true
                    }
                    Rectangle {
                      visible: txRow.modelData.account === "flex"
                      anchors.verticalCenter: parent.verticalCenter
                      width: flexLabel.implicitWidth + Style.space(8)
                      height: flexLabel.implicitHeight + Style.space(2)
                      radius: Math.min(3, Style.cornerRadius)
                      color: "transparent"
                      border.width: 1
                      border.color: root.dim

                      Text {
                        id: flexLabel
                        anchors.centerIn: parent
                        textFormat: Text.PlainText
                        text: "FLEX"
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                      }
                    }
                  }
                  Text {
                    id: txAmount
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: Model.money(txRow.modelData.amount, txRow.modelData.currency, true)
                    color: txRow.modelData.amount > 0 ? Commons.Color.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
