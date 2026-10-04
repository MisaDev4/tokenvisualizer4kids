using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Brush = System.Windows.Media.Brush;
using Clipboard = System.Windows.Clipboard;
using Color = System.Windows.Media.Color;
using ColorConverter = System.Windows.Media.ColorConverter;
using FontFamily = System.Windows.Media.FontFamily;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using MessageBox = System.Windows.MessageBox;
using Path = System.IO.Path;
using Point = System.Windows.Point;

namespace TokenTracker;

/// <summary>What the header says about the block that opened this window.</summary>
public sealed record TranscriptContext(string Title, string Subtitle, string DisplayPath);

/// <summary>One rendered row; brushes are resolved up front so the template
/// needs no converters. FullBody always carries the complete text — Body is
/// what's rendered, clipped only for gigantic rows until their note is clicked.</summary>
public sealed record TranscriptRowVm(
    string Title,
    string Detail,
    string Time,
    string Body,
    string Note,
    string FullBody,
    Brush Rail,
    Brush Ink,
    Brush Fill,
    Brush Outline,
    FontFamily Font,
    Visibility DetailVisibility,
    Visibility BodyVisibility,
    Visibility NoteVisibility);

/// <summary>
/// The conversation behind one live block: the whole transcript it was written
/// into, with that response marked. Opened by double-clicking a block, and
/// read-only — nothing here writes to the log.
/// </summary>
public partial class TranscriptWindow : Window
{
    private static readonly Brush UserRail = Frozen("#3987E5");
    private static readonly Brush AssistantRail = Frozen("#199E70");
    private static readonly Brush ThinkingRail = Frozen("#8A7FD6");
    private static readonly Brush ToolRail = Frozen("#C98500");
    private static readonly Brush ResultRail = Frozen("#7E8794");
    private static readonly Brush ErrorRail = Frozen("#E5484D");
    private static readonly Brush SystemRail = Frozen("#6B6A66");
    private static readonly Brush RowFill = Frozen("#161615");
    private static readonly Brush RowOutline = Frozen("#232322");
    private static readonly Brush AnchorFill = Frozen("#1B2637");
    private static readonly Brush AnchorOutline = Frozen("#3987E5");
    private static readonly Brush BodyInk = Frozen("#C3C2B7");
    private static readonly Brush QuietInk = Frozen("#8F8E88");
    private static readonly FontFamily ProseFont = new("Segoe UI");
    private static readonly FontFamily CodeFont = new("Consolas, Cascadia Mono, Segoe UI");

    private readonly TranscriptDocument _document;
    private readonly List<TranscriptRowVm> _rows;
    private readonly int _anchorIndex;
    private ScrollViewer? _scroller;

    public TranscriptWindow(TranscriptDocument document, TranscriptContext context, bool hidePersonal)
    {
        InitializeComponent();
        _document = document;
        _anchorIndex = document.AnchorIndex;

        Title = $"Transcript · {context.Title}";
        TitleText.Text = context.Title;
        SubtitleText.Text = context.Subtitle;
        PathText.Text = context.DisplayPath;

        var anchorGroup = _anchorIndex >= 0 && _anchorIndex < document.Entries.Count
            ? document.Entries[_anchorIndex].Group
            : -1;
        _rows = document.Entries.Select(entry => Row(entry, entry.Group == anchorGroup)).ToList();

        JumpButton.IsEnabled = _anchorIndex >= 0;
        FooterText.Text = BuildFooter(document);
        Apply("");

        if (hidePersonal)
        {
            EntryList.Visibility = Visibility.Collapsed;
            EmptyText.Visibility = Visibility.Collapsed;
            PrivacyCurtain.Visibility = Visibility.Visible;
        }
        else
        {
            Loaded += (_, _) => ScrollToAnchor();
        }
    }

    // ----- rows -------------------------------------------------------------

    /// <summary>Longest body a row renders up front. Anything above (a rare
    /// megabyte-scale tool dump) starts clipped with a click-to-expand note,
    /// because laying out a text box that long would hitch the whole window.
    /// Nothing is lost: the full text is in the row and one click shows it.</summary>
    private const int InlineBodyChars = 30_000;

    private static TranscriptRowVm Row(TranscriptEntry entry, bool isAnchor)
    {
        var rail = entry.IsError ? ErrorRail : entry.Role switch
        {
            TranscriptRole.User => UserRail,
            TranscriptRole.Assistant => AssistantRail,
            TranscriptRole.Thinking => ThinkingRail,
            TranscriptRole.ToolCall => ToolRail,
            TranscriptRole.ToolResult => ResultRail,
            _ => SystemRail
        };
        var mono = entry.Role is TranscriptRole.ToolCall or TranscriptRole.ToolResult;
        var clipped = entry.Body.Length > InlineBodyChars;
        var body = clipped ? entry.Body[..InlineBodyChars].TrimEnd() : entry.Body;
        var note = clipped
            ? $"Show the remaining {entry.Body.Length - body.Length:N0} characters"
            : "";

        return new TranscriptRowVm(
            entry.Title,
            entry.Detail ?? "",
            entry.TimestampMs > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(entry.TimestampMs).ToLocalTime().ToString("h:mm:ss tt")
                : "",
            body,
            note,
            entry.Body,
            rail,
            entry.Role is TranscriptRole.Thinking or TranscriptRole.System ? QuietInk : BodyInk,
            isAnchor ? AnchorFill : RowFill,
            isAnchor ? AnchorOutline : RowOutline,
            mono ? CodeFont : ProseFont,
            string.IsNullOrEmpty(entry.Detail) ? Visibility.Collapsed : Visibility.Visible,
            body.Length == 0 ? Visibility.Collapsed : Visibility.Visible,
            note.Length == 0 ? Visibility.Collapsed : Visibility.Visible);
    }

    /// <summary>The clipped-row note: swaps in the full body, in place, so the
    /// scroll position holds.</summary>
    private void Note_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { DataContext: TranscriptRowVm vm } || vm.Note.Length == 0)
        {
            return;
        }

        var expanded = vm with { Body = vm.FullBody, Note = "", NoteVisibility = Visibility.Collapsed };
        var index = _rows.IndexOf(vm);
        if (index >= 0)
        {
            _rows[index] = expanded;
        }

        if (EntryList.ItemsSource is System.Collections.ObjectModel.ObservableCollection<TranscriptRowVm> visible)
        {
            var visibleIndex = visible.IndexOf(vm);
            if (visibleIndex >= 0)
            {
                visible[visibleIndex] = expanded;
            }
        }

        e.Handled = true;
    }

    private string BuildFooter(TranscriptDocument document)
    {
        var parts = new List<string> { $"{document.Entries.Count:N0} entries" };
        if (document.DroppedEntries > 0)
        {
            parts.Add($"{document.DroppedEntries:N0} earlier ones not loaded");
        }

        try
        {
            parts.Add($"{new FileInfo(document.Path).Length / 1024.0 / 1024.0:0.##} MB on disk");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }

        if (document.Error is not null)
        {
            parts.Add($"read stopped: {document.Error}");
        }

        parts.Add("read-only view of the log — nothing here is written back");
        return string.Join(" · ", parts);
    }

    // ----- filtering --------------------------------------------------------

    private void Apply(string query)
    {
        var rows = query.Length == 0
            ? _rows
            : _rows.Where(row =>
                row.FullBody.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                row.Title.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                row.Detail.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();

        // Observable so a clipped row can be swapped for its expanded twin in place.
        EntryList.ItemsSource = new System.Collections.ObjectModel.ObservableCollection<TranscriptRowVm>(rows);
        CountText.Text = query.Length == 0
            ? ""
            : $"{rows.Count:N0} of {_rows.Count:N0}";

        if (_rows.Count == 0)
        {
            EmptyText.Text = "Nothing readable in this log — it holds token counts but no conversation.";
        }
        else if (rows.Count == 0)
        {
            EmptyText.Text = $"No entry mentions “{query}”.";
        }

        EmptyText.Visibility = rows.Count == 0 && PrivacyCurtain.Visibility != Visibility.Visible
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void SearchBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        SearchHint.Visibility = SearchBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        Apply(SearchBox.Text.Trim());
    }

    private void ScrollToAnchor()
    {
        if (_anchorIndex < 0 || _anchorIndex >= _rows.Count ||
            EntryList.ItemsSource is not IReadOnlyList<TranscriptRowVm> rows)
        {
            return;
        }

        var target = _rows[_anchorIndex];
        if (!rows.Contains(target))
        {
            return;
        }

        EntryList.UpdateLayout();
        EntryList.ScrollIntoView(target);

        // ScrollIntoView stops as soon as the row is visible, which leaves it
        // pinned to the bottom edge with the response's replies off-screen.
        // Nudge it up to just under the filter box instead.
        EntryList.UpdateLayout();
        if (EntryList.ItemContainerGenerator.ContainerFromItem(target) is FrameworkElement container &&
            Scroller is { } scroller)
        {
            var top = container.TransformToAncestor(scroller).Transform(default(Point)).Y;
            scroller.ScrollToVerticalOffset(scroller.VerticalOffset + top - 4);
        }
    }

    /// <summary>The list's own scroller, once its template has been applied.</summary>
    private ScrollViewer? Scroller => _scroller ??= FindScrollViewer(EntryList);

    private static ScrollViewer? FindScrollViewer(DependencyObject root)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is ScrollViewer scroller)
            {
                return scroller;
            }

            if (FindScrollViewer(child) is { } nested)
            {
                return nested;
            }
        }

        return null;
    }

    // ----- commands ---------------------------------------------------------

    private void Jump_Click(object sender, RoutedEventArgs e)
    {
        if (SearchBox.Text.Length > 0)
        {
            SearchBox.Clear();
        }

        Reveal();
        ScrollToAnchor();
    }

    private void CopyAll_Click(object sender, RoutedEventArgs e)
    {
        var builder = new System.Text.StringBuilder();
        foreach (var entry in _document.Entries)
        {
            var time = entry.TimestampMs > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(entry.TimestampMs).ToLocalTime().ToString("HH:mm:ss")
                : "--:--:--";
            builder.Append('[').Append(time).Append("] ").Append(entry.Title);
            if (!string.IsNullOrEmpty(entry.Detail))
            {
                builder.Append(" · ").Append(entry.Detail);
            }

            builder.AppendLine();
            if (entry.Body.Length > 0)
            {
                builder.AppendLine(entry.Body);
            }

            builder.AppendLine();
        }

        try
        {
            Clipboard.SetText(builder.ToString());
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, "The clipboard refused the copy: " + exception.Message,
                "Transcript", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void ShowFile_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = File.Exists(_document.Path)
                    ? $"/select,\"{_document.Path}\""
                    : $"\"{Path.GetDirectoryName(_document.Path)}\"",
                UseShellExecute = true
            });
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, "Explorer would not open: " + exception.Message,
                "Transcript", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void Reveal_Click(object sender, RoutedEventArgs e)
    {
        Reveal();
        ScrollToAnchor();
    }

    private void Reveal()
    {
        if (PrivacyCurtain.Visibility != Visibility.Visible)
        {
            return;
        }

        PrivacyCurtain.Visibility = Visibility.Collapsed;
        EntryList.Visibility = Visibility.Visible;
        Apply(SearchBox.Text.Trim());
    }

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Close();
            e.Handled = true;
            return;
        }

        if (e.Key == Key.F && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
        {
            SearchBox.Focus();
            SearchBox.SelectAll();
            e.Handled = true;
        }
    }

    /// <summary>
    /// Every row's body is a text box, and a text box eats the wheel — which is
    /// most of this window. Re-raising the event on the list does nothing: the
    /// list's scroller sits *below* it in the tree, so a bubbling event walks
    /// away from it. Scroll the thing itself.
    /// </summary>
    private void BodyText_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (Scroller is not { } scroller)
        {
            return;
        }

        // 0.4 × delta is the 48 px a notch moves everywhere else in the window,
        // so the wheel doesn't change gear as the pointer crosses a row.
        scroller.ScrollToVerticalOffset(scroller.VerticalOffset - e.Delta * 0.4);
        e.Handled = true;
    }

    private static Brush Frozen(string hex)
    {
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        return brush;
    }
}
